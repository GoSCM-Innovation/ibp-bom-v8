# Key-figure migration emulation (mirrors the app's KF flow + cursor concurrency).
# PRD ASIBPTS / ASIBPTSIRR  ACTUALSQTY (UOM KG)  ->  Calidad ASIBPTS / ZPRUEBA (upsert).
# K runspace workers pull position-segments from a shared cursor (per-worker session).
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Net.Http
$user='CLAUDE_API_USER'
$pw=@'
Xl2QAH~RKTt6Xo<Mv~A$Jg3/~8lldl%YR%8>QUL(
'@
$pw=$pw.TrimEnd("`r","`n")
$auth=[Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$user`:$pw"))
$src='https://my400439-api.scmibp.ondemand.com/sap/opu/odata/IBP/PLANNING_DATA_API_SRV'
$dst='https://my400444-api.scmibp.ondemand.com/sap/opu/odata/IBP/PLANNING_DATA_API_SRV'
[System.Net.ServicePointManager]::DefaultConnectionLimit=64
function EnvInt($n,$d){ $v=[Environment]::GetEnvironmentVariable($n); if($v){[int]$v}else{$d} }
$SEG=EnvInt 'SEG' 20000; $K=EnvInt 'K' 6; $PW=EnvInt 'PW' 4; $RP=EnvInt 'RP' 4; $RPAGE=EnvInt 'RPAGE' 3000; $MAXROWS=EnvInt 'MAXROWS' 0
$selE=[Uri]::EscapeDataString('PRDID,LOCID,CUSTID,UOMTOID,ACTUALSQTY,PERIODID4_TSTAMP')
$obE=[Uri]::EscapeDataString('PRDID,LOCID,CUSTID,PERIODID4_TSTAMP')
$VER = if($env:VER){ $env:VER } else { 'DOWNSIDE' }
$filE=[Uri]::EscapeDataString("VERSIONID eq '$VER' and UOMTOID eq 'KG' and (ACTUALSQTY gt 0 or ACTUALSQTY lt 0)")   # all non-zero (pos + neg)
$aggFields='PRDID,LOCID,CUSTID,ACTUALSQTY,PERIODID4_TSTAMP'

$c0=New-Object System.Net.Http.HttpClient; $c0.DefaultRequestHeaders.Add('Authorization',"Basic $auth"); $c0.DefaultRequestHeaders.Add('Accept','application/json')
$total=[int](($c0.GetStringAsync("$src/ASIBPTS?" + '$format=json&$top=2&$inlinecount=allpages&$select=' + $selE + '&$filter=' + $filE).Result | ConvertFrom-Json).d.__count)
if($MAXROWS -gt 0 -and $total -gt $MAXROWS){ $total=$MAXROWS }
$skipZero = (EnvInt 'SKIPZERO' 1) -ne 0
"src total=$total SEG=$SEG K=$K PW=$PW RPAGE=$RPAGE skipZero=$skipZero"
$sync=[hashtable]::Synchronized(@{ committed=0; written=0; errors=0; cursor=0 })

$worker={
  param($auth,$src,$dst,$selE,$obE,$filE,$aggFields,$RPAGE,$RP,$PW,$SEG,$total,$sync,$skipZero)
  $hh=New-Object System.Net.Http.HttpClientHandler; $hh.AllowAutoRedirect=$false
  $cli=New-Object System.Net.Http.HttpClient($hh); $cli.Timeout=[TimeSpan]::FromSeconds(180)
  $cli.DefaultRequestHeaders.Add('Authorization',"Basic $auth"); $cli.DefaultRequestHeaders.Add('Accept','application/json')
  $rq=New-Object System.Net.Http.HttpRequestMessage('GET',("$dst/ASIBPTS?" + '$format=json&$top=0')); $rq.Headers.Add('X-CSRF-Token','Fetch')
  $cz=$cli.SendAsync($rq).Result; $tok=$null;[void]$cz.Headers.TryGetValues('x-csrf-token',[ref]$tok);$tok=($tok-join'')
  $scw=$null;[void]$cz.Headers.TryGetValues('set-cookie',[ref]$scw); $cookie=(@($scw)|ForEach-Object{$_.Split(';')[0]})-join'; '
  function NP($u,$b){ $m=New-Object System.Net.Http.HttpRequestMessage('POST',$u); $m.Headers.Add('X-CSRF-Token',$tok); $m.Headers.Add('Cookie',$cookie); if($b){$m.Content=New-Object System.Net.Http.StringContent($b,[Text.Encoding]::UTF8,'application/json')}; $m }
  function IsoTime($v){ if($v -is [datetime]){ $v.ToString('yyyy-MM-ddTHH:mm:ss') } elseif($v -is [string] -and $v -match '/Date\((\d+)'){ [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$matches[1]).UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ss') } else { $v } }
  while($true){
    [Threading.Monitor]::Enter($sync); $segStart=$sync.cursor; $sync.cursor+=$SEG; [Threading.Monitor]::Exit($sync)
    if($segStart -ge $total){ break }
    $segEnd=[Math]::Min($segStart+$SEG,$total)
    # read segment
    $buf=New-Object System.Collections.ArrayList
    for($ps=$segStart;$ps -lt $segEnd;$ps+=$RPAGE*$RP){
      $tasks=@(); for($i=0;$i -lt $RP;$i++){ $sk=$ps+$i*$RPAGE; if($sk -ge $segEnd){break}; $tp=[Math]::Min($RPAGE,$segEnd-$sk); $tasks+=$cli.GetStringAsync("$src/ASIBPTS?" + '$format=json&$top=' + $tp + '&$skip=' + $sk + '&$orderby=' + $obE + '&$select=' + $selE + '&$filter=' + $filE) }
      [Threading.Tasks.Task]::WaitAll($tasks)
      foreach($tk in $tasks){ foreach($r in ($tk.Result|ConvertFrom-Json).d.results){
        $val=$r.ACTUALSQTY
        $hasVal = ($val -ne $null -and "$val".Trim() -ne '' -and [double]$val -ne 0)
        if($hasVal -or -not $skipZero){
          [void]$buf.Add([ordered]@{ PRDID=$r.PRDID; LOCID=$r.LOCID; CUSTID=$r.CUSTID; PERIODID4_TSTAMP=(IsoTime $r.PERIODID4_TSTAMP); ACTUALSQTY=$val })
        }
      } }
    }
    if($buf.Count -eq 0){ [Threading.Monitor]::Enter($sync); $sync.committed+=($segEnd-$segStart); [Threading.Monitor]::Exit($sync); continue }
    # tx + write + commit
    $tx=(($cli.GetStringAsync("$dst/getTransactionID?" + '$format=json').Result)|ConvertFrom-Json).d.Value
    [void]$cli.SendAsync((NP ("$dst/InitiateParallelProcess?Transactionid=%27$tx%27&VersionID=%27ZPRUEBA%27&ScenarioID=%27%27&PlanningArea=%27ASIBPTS%27&TransactionName=%27kf-emu%27&" + '$format=json') $null)).Result
    $WC=2500; $chunks=@(); for($c=0;$c -lt $buf.Count;$c+=$WC){ $chunks+=,($buf.GetRange($c,[Math]::Min($WC,$buf.Count-$c))) }
    for($ci=0;$ci -lt $chunks.Count;$ci+=$PW){
      $wt=@(); for($w=0;$w -lt $PW -and ($ci+$w) -lt $chunks.Count;$w++){ $body=@{ Transactionid=$tx; AggregationLevelFieldsString=$aggFields; DoCommit=$false; VersionID='ZPRUEBA'; NavASIBPTS=$chunks[$ci+$w] }|ConvertTo-Json -Depth 12; $wt+=$cli.SendAsync((NP "$dst/ASIBPTSTrans" $body)) }
      [Threading.Tasks.Task]::WaitAll($wt)
      foreach($t in $wt){ if(-not $t.Result.IsSuccessStatusCode){ [Threading.Monitor]::Enter($sync); $sync.errors++; [Threading.Monitor]::Exit($sync); if($sync.errors -le 3){ "POST err $([int]$t.Result.StatusCode): " + $t.Result.Content.ReadAsStringAsync().Result.Substring(0,[Math]::Min(160,$t.Result.Content.ReadAsStringAsync().Result.Length)) } } }
    }
    $cm=$cli.SendAsync((NP ("$dst/commit?P_TransactionID=%27$tx%27") $null)).Result
    [Threading.Monitor]::Enter($sync); if(-not $cm.IsSuccessStatusCode){$sync.errors++}; $sync.committed+=($segEnd-$segStart); $sync.written+=$buf.Count; [Threading.Monitor]::Exit($sync)
  }
}

$pool=[runspacefactory]::CreateRunspacePool(1,$K); $pool.Open(); $jobs=@()
$sw=[Diagnostics.Stopwatch]::StartNew()
for($i=0;$i -lt $K;$i++){ $ps=[powershell]::Create(); $ps.RunspacePool=$pool; [void]$ps.AddScript($worker).AddArgument($auth).AddArgument($src).AddArgument($dst).AddArgument($selE).AddArgument($obE).AddArgument($filE).AddArgument($aggFields).AddArgument($RPAGE).AddArgument($RP).AddArgument($PW).AddArgument($SEG).AddArgument($total).AddArgument($sync).AddArgument($skipZero); $jobs+=@{ps=$ps;h=$ps.BeginInvoke()} }
foreach($j in $jobs){ $j.ps.EndInvoke($j.h); $j.ps.Dispose() }
$pool.Close(); $sw.Stop()
"DONE read=$($sync.committed) written=$($sync.written) errors=$($sync.errors) wall=$([int]$sw.Elapsed.TotalSeconds)s rows/s=$([int]($sync.committed/$sw.Elapsed.TotalSeconds))"