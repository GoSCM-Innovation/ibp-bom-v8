# Concurrent validation: K runspace workers pull segments from a shared queue and
# run read->write->commit independently (mirrors the app's CONCURRENT_SEGMENTS pool).
# Writes to Calidad/ZPRUEBA (upsert). Confirms throughput + 0 errors end-to-end.
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
[System.Net.ServicePointManager]::DefaultConnectionLimit=64
function EnvInt($n,$d){ $v=[Environment]::GetEnvironmentVariable($n); if($v){[int]$v}else{$d} }
$MAXROWS=EnvInt 'MAXROWS' 240000
$SEG=EnvInt 'SEG' 20000
$K=EnvInt 'K' 4
$PW=EnvInt 'PW' 6
$common='CBALANCERECEIPTSCOPE,CINVALID,CLEADTIME,CLEADTIMEROUNDINGTHRESHOLD,CPRIORITY,CRATIO,CROUNDING,CUSTID,FCSTALGORITHM,FCSTCONSMODE,LOCID,MATTRSOURCECUSTOMER,PRDID,RATIOTS,TIMESERIESPROPERTY,ZCOMBSOURCECUSTOMER'.Split(',')
$reqAttr=($common -join ',')
$selE=[Uri]::EscapeDataString(($common -join ','))
$obE=[Uri]::EscapeDataString('CUSTID,LOCID,PRDID')
$filE=[Uri]::EscapeDataString("PlanningAreaID eq 'ASIBPTS'")
$RPAGE=1036; $RP=6

# CSRF (shared across workers)
$h0=New-Object System.Net.Http.HttpClientHandler; $h0.AllowAutoRedirect=$false
$c0=New-Object System.Net.Http.HttpClient($h0); $c0.DefaultRequestHeaders.Add('Authorization',"Basic $auth"); $c0.DefaultRequestHeaders.Add('Accept','application/json')
$req=New-Object System.Net.Http.HttpRequestMessage('GET',("$cal/AS1SOURCECUSTOMER?" + '$format=json&$top=0')); $req.Headers.Add('X-CSRF-Token','Fetch')
$cz=$c0.SendAsync($req).Result
$tok=$null;[void]$cz.Headers.TryGetValues('x-csrf-token',[ref]$tok);$tok=($tok-join'')
$sc=$null;[void]$cz.Headers.TryGetValues('set-cookie',[ref]$sc); $cookie=(@($sc)|ForEach-Object{$_.Split(';')[0]})-join'; '

$total=[int](($c0.GetStringAsync("$prd/AS1SOURCECUSTOMER?" + '$format=json&$top=0&$inlinecount=allpages&$filter=' + $filE).Result | ConvertFrom-Json).d.__count)
if($total -gt $MAXROWS){ $total=$MAXROWS }
$queue=New-Object System.Collections.Concurrent.ConcurrentQueue[int]
for($s=0;$s -lt $total;$s+=$SEG){ $queue.Enqueue($s) }
$sync=[hashtable]::Synchronized(@{ committed=0; errors=0 })
"K=$K SEG=$SEG total=$total segments=$($queue.Count) PW=$PW"

$worker={
  param($auth,$prd,$cal,$common,$reqAttr,$selE,$obE,$filE,$RPAGE,$RP,$PW,$SEG,$total,$tok,$cookie,$queue,$sync)
  $hh=New-Object System.Net.Http.HttpClientHandler; $hh.AllowAutoRedirect=$false
  $cli=New-Object System.Net.Http.HttpClient($hh); $cli.Timeout=[TimeSpan]::FromSeconds(180)
  $cli.DefaultRequestHeaders.Add('Authorization',"Basic $auth"); $cli.DefaultRequestHeaders.Add('Accept','application/json')
  # Each worker fetches its OWN CSRF (own session) — a fresh HttpClient can't reuse
  # another client's token/cookies. (The app uses ONE session, so this is heavier.)
  $rq=New-Object System.Net.Http.HttpRequestMessage('GET',("$cal/AS1SOURCECUSTOMER?" + '$format=json&$top=0')); $rq.Headers.Add('X-CSRF-Token','Fetch')
  $cz=$cli.SendAsync($rq).Result
  $tok=$null;[void]$cz.Headers.TryGetValues('x-csrf-token',[ref]$tok);$tok=($tok-join'')
  $scw=$null;[void]$cz.Headers.TryGetValues('set-cookie',[ref]$scw); $cookie=(@($scw)|ForEach-Object{$_.Split(';')[0]})-join'; '
  function NP($url,$body){ $m=New-Object System.Net.Http.HttpRequestMessage('POST',$url); $m.Headers.Add('X-CSRF-Token',$tok); $m.Headers.Add('Cookie',$cookie); if($body){$m.Content=New-Object System.Net.Http.StringContent($body,[Text.Encoding]::UTF8,'application/json')}; $m }
  $segStart=0
  while($queue.TryDequeue([ref]$segStart)){
    $segEnd=[Math]::Min($segStart+$SEG,$total)
    # read
    $buf=New-Object System.Collections.ArrayList
    for($ps=$segStart;$ps -lt $segEnd;$ps+=$RPAGE*$RP){
      $tasks=@(); for($i=0;$i -lt $RP;$i++){ $sk=$ps+$i*$RPAGE; if($sk -ge $segEnd){break}; $tp=[Math]::Min($RPAGE,$segEnd-$sk); $tasks+=$cli.GetStringAsync("$prd/AS1SOURCECUSTOMER?" + '$format=json&$top=' + $tp + '&$skip=' + $sk + '&$orderby=' + $obE + '&$select=' + $selE + '&$filter=' + $filE) }
      [Threading.Tasks.Task]::WaitAll($tasks)
      foreach($tk in $tasks){ foreach($r in ($tk.Result|ConvertFrom-Json).d.results){ $o=[ordered]@{}; foreach($k in $common){$o[$k]=$r.$k}; [void]$buf.Add($o) } }
    }
    # tx + write + commit
    $tx=(($cli.GetStringAsync("$cal/GetTransactionID?TransactionName=%27cc%27&VersionID=%27ZPRUEBA%27&TransactionID=%27%27&MasterDataTypeID=%27AS1SOURCECUSTOMER%27&PlanningArea=%27ASIBPTS%27&" + '$format=json').Result)|ConvertFrom-Json).d.Value
    [void]$cli.SendAsync((NP ("$cal/InitiateParallelProcess?TransactionID=%27$tx%27&VersionID=%27ZPRUEBA%27&MasterDataTypeID=%27AS1SOURCECUSTOMER%27&PlanningArea=%27ASIBPTS%27&" + '$format=json') $null)).Result
    $WC=2500; $chunks=@(); for($c=0;$c -lt $buf.Count;$c+=$WC){ $chunks+=,($buf.GetRange($c,[Math]::Min($WC,$buf.Count-$c))) }
    for($ci=0;$ci -lt $chunks.Count;$ci+=$PW){
      $wt=@(); for($w=0;$w -lt $PW -and ($ci+$w) -lt $chunks.Count;$w++){ $body=@{TransactionID=$tx;PlanningAreaID='ASIBPTS';VersionID='ZPRUEBA';DoCommit=$false;DeleteEntries=$false;RequestedAttributes=$reqAttr;NavAS1SOURCECUSTOMER=@{results=$chunks[$ci+$w]}}|ConvertTo-Json -Depth 12; $wt+=$cli.SendAsync((NP "$cal/AS1SOURCECUSTOMERTrans" $body)) }
      [Threading.Tasks.Task]::WaitAll($wt)
      foreach($t in $wt){ if([int]$t.Result.StatusCode -ne 201){ [Threading.Monitor]::Enter($sync); $sync.errors++; [Threading.Monitor]::Exit($sync) } }
    }
    $cm=$cli.SendAsync((NP ("$cal/Commit?P_TransactionID=%27$tx%27") $null)).Result
    [Threading.Monitor]::Enter($sync); if([int]$cm.StatusCode -ne 200){$sync.errors++}; $sync.committed+=$buf.Count; [Threading.Monitor]::Exit($sync)
  }
}

$pool=[runspacefactory]::CreateRunspacePool(1,$K); $pool.Open()
$jobs=@()
$sw=[Diagnostics.Stopwatch]::StartNew()
for($i=0;$i -lt $K;$i++){
  $ps=[powershell]::Create(); $ps.RunspacePool=$pool
  [void]$ps.AddScript($worker).AddArgument($auth).AddArgument($prd).AddArgument($cal).AddArgument($common).AddArgument($reqAttr).AddArgument($selE).AddArgument($obE).AddArgument($filE).AddArgument($RPAGE).AddArgument($RP).AddArgument($PW).AddArgument($SEG).AddArgument($total).AddArgument($tok).AddArgument($cookie).AddArgument($queue).AddArgument($sync)
  $jobs+=@{ ps=$ps; handle=$ps.BeginInvoke() }
}
foreach($j in $jobs){ $j.ps.EndInvoke($j.handle); $j.ps.Dispose() }
$pool.Close()
$sw.Stop()
$rps=[int]($sync.committed/$sw.Elapsed.TotalSeconds)
"DONE committed=$($sync.committed) errors=$($sync.errors) wall=$([int]$sw.Elapsed.TotalSeconds)s rows/s=$rps"