# Concurrency ceiling test: how many CONCURRENT transactions (each posting chunks
# in parallel) can SAP IBP sustain before write throughput plateaus or it errors?
# Writes small samples to Calidad/ZPRUEBA (upsert). Read time is excluded — only the
# write+commit wall is measured, isolating WRITE throughput vs concurrency.
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Net.Http
$user='CLAUDE_API_USER'
$pw=@'
Xl2QAH~RKTt6Xo<Mv~A$Jg3/~8lldl%YR%8>QUL(
'@
$pw=$pw.TrimEnd("`r","`n")
$auth=[Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$user`:$pw"))
$prd='https://my400439-api.scmibp.ondemand.com/sap/opu/odata/IBP/MASTER_DATA_API_SRV'
$cal='https://my400444-api.scmibp.ondemand.com/sap/opu/odata/IBP/MASTER_DATA_API_SRV'
$h=New-Object System.Net.Http.HttpClientHandler; $h.AllowAutoRedirect=$false; $h.MaxConnectionsPerServer=64
[System.Net.ServicePointManager]::DefaultConnectionLimit=64
$cli=New-Object System.Net.Http.HttpClient($h); $cli.Timeout=[TimeSpan]::FromSeconds(180)
$cli.DefaultRequestHeaders.Add('Authorization',"Basic $auth"); $cli.DefaultRequestHeaders.Add('Accept','application/json')
function GetJ($u){ ($cli.GetAsync($u).Result.Content.ReadAsStringAsync().Result | ConvertFrom-Json) }
$common='CBALANCERECEIPTSCOPE,CINVALID,CLEADTIME,CLEADTIMEROUNDINGTHRESHOLD,CPRIORITY,CRATIO,CROUNDING,CUSTID,FCSTALGORITHM,FCSTCONSMODE,LOCID,MATTRSOURCECUSTOMER,PRDID,RATIOTS,TIMESERIESPROPERTY,ZCOMBSOURCECUSTOMER'.Split(',')
$reqAttr=($common -join ',')
$selE=[Uri]::EscapeDataString(($common -join ','))
$obE=[Uri]::EscapeDataString('CUSTID,LOCID,PRDID')
$filE=[Uri]::EscapeDataString("PlanningAreaID eq 'ASIBPTS'")

# CSRF
$req=New-Object System.Net.Http.HttpRequestMessage('GET',("$cal/AS1SOURCECUSTOMER?" + '$format=json&$top=0'))
$req.Headers.Add('X-CSRF-Token','Fetch'); $cr=$cli.SendAsync($req).Result
$tok=$null;[void]$cr.Headers.TryGetValues('x-csrf-token',[ref]$tok);$tok=($tok-join'')
$sc=$null;[void]$cr.Headers.TryGetValues('set-cookie',[ref]$sc); $cookie=(@($sc)|ForEach-Object{$_.Split(';')[0]})-join'; '
function NewPost($url,$bodyJson){ $m=New-Object System.Net.Http.HttpRequestMessage('POST',$url); $m.Headers.Add('X-CSRF-Token',$tok); $m.Headers.Add('Cookie',$cookie); if($bodyJson){ $m.Content=New-Object System.Net.Http.StringContent($bodyJson,[Text.Encoding]::UTF8,'application/json') }; $m }
function NewTx(){ (GetJ ("$cal/GetTransactionID?TransactionName=%27ceil%27&VersionID=%27ZPRUEBA%27&TransactionID=%27%27&MasterDataTypeID=%27AS1SOURCECUSTOMER%27&PlanningArea=%27ASIBPTS%27&" + '$format=json')).d.Value }

$M=12000; $CH=2400          # rows per transaction, rows per chunk (5 chunks/tx)
$maxK=4
# Pre-read enough rows once (read time excluded from measurement)
"reading $($maxK*$M) sample rows..."
$buf=New-Object System.Collections.ArrayList
$rp=1000
for($sk=0; $buf.Count -lt $maxK*$M; $sk+=$rp){
  $t=$cli.GetStringAsync("$prd/AS1SOURCECUSTOMER?" + '$format=json&$top=' + $rp + '&$skip=' + $sk + '&$orderby=' + $obE + '&$select=' + $selE + '&$filter=' + $filE).Result
  foreach($r in ($t|ConvertFrom-Json).d.results){ $o=[ordered]@{}; foreach($k in $common){ $o[$k]=$r.$k }; [void]$buf.Add($o) }
}
"buffered $($buf.Count) rows`n--- K | rows/s | wall | errors ---"

foreach($K in 1,2,3,4){
  # Build K transactions, each with M rows split into CH-sized chunks
  $txs=@(); for($i=0;$i -lt $K;$i++){ $txs+=(NewTx) }
  $bodies=@()  # list of @(txIndex, bodyJson)
  for($i=0;$i -lt $K;$i++){
    $grp=$buf.GetRange($i*$M,$M)
    for($c=0;$c -lt $grp.Count;$c+=$CH){
      $slice=$grp.GetRange($c,[Math]::Min($CH,$grp.Count-$c))
      $bodies+=,(@{ TransactionID=$txs[$i]; PlanningAreaID='ASIBPTS'; VersionID='ZPRUEBA'; DoCommit=$false; DeleteEntries=$false; RequestedAttributes=$reqAttr; NavAS1SOURCECUSTOMER=@{ results=$slice } } | ConvertTo-Json -Depth 12)
    }
  }
  $sw=[Diagnostics.Stopwatch]::StartNew()
  $tasks=@(); foreach($b in $bodies){ $tasks+=$cli.SendAsync((NewPost "$cal/AS1SOURCECUSTOMERTrans" $b)) }
  [Threading.Tasks.Task]::WaitAll($tasks)
  $errs=0; foreach($t in $tasks){ if([int]$t.Result.StatusCode -ne 201){ $errs++ } }
  $ctasks=@(); foreach($tx in $txs){ $ctasks+=$cli.SendAsync((NewPost ("$cal/Commit?P_TransactionID=%27$tx%27") $null)) }
  [Threading.Tasks.Task]::WaitAll($ctasks)
  foreach($t in $ctasks){ if([int]$t.Result.StatusCode -ne 200){ $errs++ } }
  $sw.Stop()
  $rps=[int](($K*$M)/$sw.Elapsed.TotalSeconds)
  "K=$K  concurrentPOSTs=$($bodies.Count)  rows/s=$rps  wall=$([int]$sw.Elapsed.TotalSeconds)s  errors=$errs"
}