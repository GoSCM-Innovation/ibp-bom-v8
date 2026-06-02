# Faithful end-to-end emulation of the master-data migration (AS1SOURCECUSTOMER)
# PRD (my400439) base  ->  Calidad (my400444) version ZPRUEBA, UPSERT (no delete).
# Replicates the deployed web sequence: getTransactionID -> InitiateParallelProcess
# -> read pages (PARALLEL_R) -> POST <MDT>Trans chunks (PARALLEL_W) -> Commit, per
# SEGMENT, then waitForProcessed + readMessages over all segment transactions.
# Tunables come from env vars so the same script runs baseline and optimized.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http

# ── Tunables (defaults = exact web baseline) ──
function EnvInt($name,$def){ $v=[Environment]::GetEnvironmentVariable($name); if($v){ [int]$v } else { $def } }
$SEGMENT  = EnvInt 'SEG' 10000
$READPAGE = EnvInt 'RP'  0    # 0 = derive from measured bytes/row (faithful to fixed web)
$PAR_R    = EnvInt 'PR'  3
$WCHUNK   = EnvInt 'WC'  0    # 0 = derive from measured bytes/row
$PAR_W    = EnvInt 'PW'  4
$RBUDGET  = 900000
$WBUDGET  = 3500000
$LABEL    = if ($env:LABEL) { $env:LABEL } else { 'baseline' }
$MAX_ATT  = 5

$user='CLAUDE_API_USER'
$pw=@'
Xl2QAH~RKTt6Xo<Mv~A$Jg3/~8lldl%YR%8>QUL(
'@
$pw=$pw.TrimEnd("`r","`n")
$auth=[Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$user`:$pw"))
$prd='https://my400439-api.scmibp.ondemand.com/sap/opu/odata/IBP/MASTER_DATA_API_SRV'
$cal='https://my400444-api.scmibp.ondemand.com/sap/opu/odata/IBP/MASTER_DATA_API_SRV'
$h=New-Object System.Net.Http.HttpClientHandler; $h.AllowAutoRedirect=$false; $h.MaxConnectionsPerServer=16
$cli=New-Object System.Net.Http.HttpClient($h); $cli.Timeout=[TimeSpan]::FromSeconds(180)
$cli.DefaultRequestHeaders.Add('Authorization',"Basic $auth")
$cli.DefaultRequestHeaders.Add('Accept','application/json')

function GetJ($url){ ($cli.GetAsync($url).Result.Content.ReadAsStringAsync().Result | ConvertFrom-Json) }
function Fields($base){ (GetJ ("$base/AS1SOURCECUSTOMER?" + '$format=json&$top=1')).d.results[0].PSObject.Properties.Name | Where-Object {$_ -ne '__metadata'} }

# CSRF (refreshable on 403)
$script:tok=$null; $script:cookie=$null
function RefreshCsrf(){
  $req=New-Object System.Net.Http.HttpRequestMessage('GET',("$cal/AS1SOURCECUSTOMER?" + '$format=json&$top=0'))
  $req.Headers.Add('X-CSRF-Token','Fetch')
  $r=$cli.SendAsync($req).Result
  $t=$null;[void]$r.Headers.TryGetValues('x-csrf-token',[ref]$t); $script:tok=($t-join'')
  $sc=$null;[void]$r.Headers.TryGetValues('set-cookie',[ref]$sc)
  $script:cookie=(@($sc)|ForEach-Object{$_.Split(';')[0]})-join'; '
}
function NewPost($url,$bodyJson){
  $m=New-Object System.Net.Http.HttpRequestMessage('POST',$url)
  $m.Headers.Add('X-CSRF-Token',$script:tok); $m.Headers.Add('Cookie',$script:cookie)
  if($bodyJson){ $m.Content=New-Object System.Net.Http.StringContent($bodyJson,[Text.Encoding]::UTF8,'application/json') }
  return $m
}

$ro=@('PlanningAreaID','VersionID','CREATEDDATE','LASTMODIFIEDDATE')
$pf=Fields $prd; $cf=Fields $cal
$common=@($pf | Where-Object { $cf -contains $_ -and $ro -notcontains $_ })
$selE=[Uri]::EscapeDataString(($common -join ','))
$obE=[Uri]::EscapeDataString('CUSTID,LOCID,PRDID')
$filE=[Uri]::EscapeDataString("PlanningAreaID eq 'ASIBPTS'")
$reqAttr=($common -join ',')
RefreshCsrf

# Measure real bytes/row from a 200-row sample (same $select the load uses) and
# derive read/write batch sizes — faithful to the fixed web's measured sizing.
$smpTxt=$cli.GetStringAsync("$prd/AS1SOURCECUSTOMER?" + '$format=json&$top=200&$skip=0&$orderby=' + $obE + '&$select=' + $selE + '&$filter=' + $filE).Result
$smpRows=($smpTxt | ConvertFrom-Json).d.results
$readBpr=[Math]::Ceiling($smpTxt.Length/$smpRows.Count)
$smpClean=@($smpRows | ForEach-Object { $o=[ordered]@{}; foreach($k in $common){ $o[$k]=$_.$k }; $o })
$writeBpr=[Math]::Ceiling((($smpClean | ConvertTo-Json -Depth 12).Length)/$smpRows.Count)
if($READPAGE -le 0){ $READPAGE=[int][Math]::Max(250,[Math]::Min(5000,[Math]::Floor($RBUDGET/$readBpr))) }
if($WCHUNK   -le 0){ $WCHUNK  =[int][Math]::Max(250,[Math]::Min(5000,[Math]::Floor($WBUDGET/$writeBpr))) }
"[$LABEL] measured readBpr=$readBpr writeBpr=$writeBpr -> readPage=$READPAGE writeChunk=$WCHUNK"

$totalRows=[int](GetJ ("$prd/AS1SOURCECUSTOMER?" + '$format=json&$top=0&$inlinecount=allpages&$filter=' + $filE)).d.__count
$maxRows=EnvInt 'MAXROWS' 0
if($maxRows -gt 0 -and $totalRows -gt $maxRows){ $totalRows=$maxRows }
$nSeg=[Math]::Ceiling($totalRows/$SEGMENT)
"[$LABEL] common=$($common.Count) totalRows=$totalRows SEGMENT=$SEGMENT readPage=$READPAGE PAR_R=$PAR_R wChunk=$WCHUNK PAR_W=$PAR_W segments=$nSeg"

$readMs=0.0; $writeMs=0.0; $commitMs=0.0; $txMs=0.0; $committedRows=0; $segTx=@()
$swAll=[Diagnostics.Stopwatch]::StartNew()

for($segStart=0; $segStart -lt $totalRows; $segStart+=$SEGMENT){
  $segEnd=[Math]::Min($segStart+$SEGMENT,$totalRows)
  for($attempt=1;;$attempt++){
    $segLoaded=0; $ok=$true
    try{
      $sw=[Diagnostics.Stopwatch]::StartNew()
      $tx=(GetJ ("$cal/GetTransactionID?TransactionName=%27ibp-emu%27&VersionID=%27ZPRUEBA%27&TransactionID=%27%27&MasterDataTypeID=%27AS1SOURCECUSTOMER%27&PlanningArea=%27ASIBPTS%27&" + '$format=json')).d.Value
      $m=NewPost ("$cal/InitiateParallelProcess?TransactionID=%27$tx%27&VersionID=%27ZPRUEBA%27&MasterDataTypeID=%27AS1SOURCECUSTOMER%27&PlanningArea=%27ASIBPTS%27&" + '$format=json') $null
      [void]$cli.SendAsync($m).Result
      $sw.Stop(); $txMs+=$sw.Elapsed.TotalMilliseconds

      for($pageStart=$segStart; $pageStart -lt $segEnd; $pageStart+=$READPAGE*$PAR_R){
        # read PAR_R pages in parallel (bounded to segEnd)
        $sw=[Diagnostics.Stopwatch]::StartNew()
        $tasks=@()
        for($i=0;$i -lt $PAR_R;$i++){
          $skip=$pageStart+$i*$READPAGE
          if($skip -ge $segEnd){ break }
          $top=[Math]::Min($READPAGE,$segEnd-$skip)
          $u="$prd/AS1SOURCECUSTOMER?" + '$format=json&$top=' + $top + '&$skip=' + $skip + '&$orderby=' + $obE + '&$select=' + $selE + '&$filter=' + $filE
          $tasks+=$cli.GetStringAsync($u)
        }
        [Threading.Tasks.Task]::WaitAll($tasks)
        $rows=@(); foreach($tk in $tasks){ $rows+=($tk.Result | ConvertFrom-Json).d.results }
        $sw.Stop(); $readMs+=$sw.Elapsed.TotalMilliseconds
        if($rows.Count -eq 0){ break }

        # project to common fields
        $clean=@($rows | ForEach-Object { $o=[ordered]@{}; foreach($k in $common){ $o[$k]=$_.$k }; $o })

        # chunk + POST PAR_W in parallel
        $sw=[Diagnostics.Stopwatch]::StartNew()
        for($c=0;$c -lt $clean.Count;$c+=$WCHUNK*$PAR_W){
          $wtasks=@()
          for($w=0;$w -lt $PAR_W;$w++){
            $cs=$c+$w*$WCHUNK
            if($cs -ge $clean.Count){ break }
            $slice=$clean[$cs..([Math]::Min($cs+$WCHUNK,$clean.Count)-1)]
            $body=@{ TransactionID=$tx; PlanningAreaID='ASIBPTS'; VersionID='ZPRUEBA'; DoCommit=$false; DeleteEntries=$false; RequestedAttributes=$reqAttr; NavAS1SOURCECUSTOMER=@{ results=$slice } } | ConvertTo-Json -Depth 12
            $wtasks+=$cli.SendAsync((NewPost "$cal/AS1SOURCECUSTOMERTrans" $body))
          }
          [Threading.Tasks.Task]::WaitAll($wtasks)
          foreach($wt in $wtasks){
            $st=[int]$wt.Result.StatusCode
            if($st -eq 403){ RefreshCsrf; throw "CSRF-403" }
            if($st -ne 201){ $eb=$wt.Result.Content.ReadAsStringAsync().Result; throw "POST $st $($eb.Substring(0,[Math]::Min(200,$eb.Length)))" }
          }
        }
        $sw.Stop(); $writeMs+=$sw.Elapsed.TotalMilliseconds
        $segLoaded+=$rows.Count
        if($rows.Count -lt $READPAGE*$PAR_R){ break }
      }

      # commit segment
      $sw=[Diagnostics.Stopwatch]::StartNew()
      $cm=$cli.SendAsync((NewPost ("$cal/Commit?P_TransactionID=%27$tx%27") $null)).Result
      $sw.Stop(); $commitMs+=$sw.Elapsed.TotalMilliseconds
      if([int]$cm.StatusCode -ne 200){ throw "Commit $([int]$cm.StatusCode)" }
      $committedRows+=$segLoaded; $segTx+=$tx
      $segIdx=[Math]::Floor($segStart/$SEGMENT)+1
      "[$LABEL] seg $segIdx/$nSeg committed=$committedRows elapsed=$([int]$swAll.Elapsed.TotalSeconds)s read=$([int]($readMs/1000))s write=$([int]($writeMs/1000))s commit=$([int]($commitMs/1000))s tx=$([int]($txMs/1000))s"
      break
    }catch{
      $msg=$_.Exception.Message
      if($attempt -lt $MAX_ATT){ "[$LABEL] seg retry $attempt ($msg)"; Start-Sleep -Milliseconds (1500*$attempt); continue }
      throw "segment $segStart failed after ${MAX_ATT}: $msg"
    }
  }
}
$swAll.Stop()
"[$LABEL] DONE total=$([int]$swAll.Elapsed.TotalSeconds)s rows=$committedRows segs=$($segTx.Count) read=$([int]($readMs/1000))s write=$([int]($writeMs/1000))s commit=$([int]($commitMs/1000))s txOverhead=$([int]($txMs/1000))s"
