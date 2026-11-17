param([string]$BaseUrl='http://127.0.0.1:18081',[string]$DataRoot=(Join-Path $PSScriptRoot 'qa-server'))
$ErrorActionPreference='Stop'
$script:Checks=0
function CallApi([string]$Method,[string]$Path,$Body=$null,[string]$Token='', [int]$Expected=200) {
    $headers=@{}
    if($Token){$headers.Authorization="Bearer $Token"}
    $params=@{Uri="$BaseUrl$Path";Method=$Method;Headers=$headers;SkipHttpErrorCheck=$true}
    if($null -ne $Body){$params.Body=ConvertTo-Json -InputObject $Body -Depth 10 -Compress;$params.ContentType='application/json; charset=utf-8'}
    $r=Invoke-WebRequest @params
    if([int]$r.StatusCode -ne $Expected){throw "$Method $Path expected $Expected got $($r.StatusCode): $($r.Content)"}
    $script:Checks++
    return ($r.Content | ConvertFrom-Json)
}
function Check($Value,[string]$Message){if(-not $Value){throw $Message};$script:Checks++}
$suffix=[guid]::NewGuid().ToString('N').Substring(0,8)
$password='Test-Only!123'
$health=CallApi GET /api/health
Check ($health.ok -eq $true) 'health failed'
$spaces=CallApi GET /api/spaces
Check ($spaces.spaces.Count -eq 3) 'catalog count'
$null=CallApi GET /api/requests $null '' 401
$setup=Get-Content -LiteralPath (Join-Path $DataRoot 'data/owner-setup-key.txt') -Raw
$owner=CallApi POST /api/auth/register @{email="owner-$suffix@example.test";password=$password;name='QA owner';owner=$true;setupKey=$setup.Trim()}
$a=CallApi POST /api/auth/register @{email="a-$suffix@example.test";password=$password;name='QA original customer'}
$b=CallApi POST /api/auth/register @{email="b-$suffix@example.test";password=$password;name='QA requester'}
$c=CallApi POST /api/auth/register @{email="c-$suffix@example.test";password=$password;name='QA unrelated'}
$null=CallApi POST /api/auth/login @{email="b-$suffix@example.test";password='wrong'} '' 401
$login=CallApi POST /api/auth/login @{email="b-$suffix@example.test";password=$password}
Check ($login.user.id -eq $b.user.id) 'login returned incorrect user'
$null=CallApi POST /api/auth/register @{email="b-$suffix@example.test";password=$password;name='Duplicate'} '' 409
$null=CallApi POST /api/auth/register @{email="bad-owner-$suffix@example.test";password=$password;name='bad';owner=$true;setupKey='wrong'} '' 403
$initial=CallApi GET /api/favorites $null $b.token
Check ($initial.ids.Count -eq 0) 'initial favorites not empty'
$null=CallApi POST /api/favorites @{spaceId=1;saved=$true} $b.token
$null=CallApi POST /api/favorites @{spaceId=1;saved=$true} $b.token
$fav=CallApi GET /api/favorites $null $b.token
Check ($fav.ids -contains 1 -and $fav.ids.Count -eq 1) 'favorite not persisted/idempotent'
$null=CallApi POST /api/favorites @{spaceId=1;saved=$false} $b.token
$removed=CallApi GET /api/favorites $null $b.token
Check ($removed.ids.Count -eq 0) 'favorite remove failed'
$null=CallApi POST /api/favorites @{spaceId=1;saved=$true} $b.token
$favOther=CallApi GET /api/favorites $null $c.token
Check ($favOther.ids.Count -eq 0) 'favorites leaked across users'
$d=(Get-Date).AddDays(7).ToString('yyyy-MM-dd')
$alt=(Get-Date).AddDays(8).ToString('yyyy-MM-dd')
$request=@{spaceId=1;date=$d;time='14:00';duration=120;budget=20000}
$invalid=$request.Clone();$invalid.date='2025-02-30'
$null=CallApi POST /api/requests $invalid $b.token 400
$invalid=$request.Clone();$invalid.time='21:00'
$null=CallApi POST /api/requests $invalid $b.token 400
$r=CallApi POST /api/requests $request $b.token
Check ($r.status -eq 'pending') 'new request not pending'
$null=CallApi POST /api/requests $request $b.token 409
$others=CallApi GET /api/requests $null $c.token
Check ($others.requests.Count -eq 0) 'request data leaked'
$null=CallApi GET "/api/requests/$($r.id)/events" $null $c.token 403
$null=CallApi POST "/api/requests/$($r.id)/action" @{action='cancel'} $c.token 403
$null=CallApi POST "/api/requests/$($r.id)/action" @{action='confirm';originalSystemUpdated=$true;confirmationReference='QA'} $owner.token 409
$proposal=@{action='propose';recipientEmail=$a.user.email;alternativeDate=$alt;alternativeTime='14:00';reward=15000;bookingReference='QA-ORIGINAL'}
$null=CallApi POST "/api/requests/$($r.id)/action" $proposal $b.token 403
$tooHigh=$proposal.Clone();$tooHigh.reward=30000
$null=CallApi POST "/api/requests/$($r.id)/action" $tooHigh $owner.token 400
$selfOverlap=$proposal.Clone();$selfOverlap.alternativeDate=$d;$selfOverlap.alternativeTime='15:00'
$null=CallApi POST "/api/requests/$($r.id)/action" $selfOverlap $owner.token 400
$p=CallApi POST "/api/requests/$($r.id)/action" $proposal $owner.token
Check ($p.status -eq 'proposed') 'proposal state'
$received=CallApi GET /api/requests $null $a.token
Check ($received.requests.id -contains $r.id) 'recipient cannot read offer'
$null=CallApi POST "/api/requests/$($r.id)/action" @{action='accept'} $b.token 409
$p=CallApi POST "/api/requests/$($r.id)/action" @{action='accept'} $a.token
Check ($p.status -eq 'accepted_a') 'A acceptance state'
$null=CallApi POST "/api/requests/$($r.id)/action" @{action='accept'} $a.token 409
$p=CallApi POST "/api/requests/$($r.id)/action" @{action='accept'} $b.token
Check ($p.status -eq 'accepted_b') 'B acceptance state'
$null=CallApi POST "/api/requests/$($r.id)/action" @{action='confirm';originalSystemUpdated=$false;confirmationReference='QA'} $owner.token 400
$confirmed=CallApi POST "/api/requests/$($r.id)/action" @{action='confirm';originalSystemUpdated=$true;confirmationReference='QA-MANUAL-CONFIRM'} $owner.token
Check ($confirmed.status -eq 'confirmed' -and $confirmed.paymentStatus -eq 'not_integrated' -and $confirmed.rewardStatus -eq 'not_paid') 'confirmation/payment truthfulness'
$null=CallApi POST "/api/requests/$($r.id)/action" @{action='cancel'} $b.token 409
$events=CallApi GET "/api/requests/$($r.id)/events" $null $b.token
Check ($events.events.Count -eq 5) 'audit history incomplete'
# An overlapping confirmed request must be rejected.
$conflict=CallApi POST /api/requests $request $c.token
$null=CallApi POST "/api/requests/$($conflict.id)/action" $proposal $owner.token
$null=CallApi POST "/api/requests/$($conflict.id)/action" @{action='accept'} $a.token
$null=CallApi POST "/api/requests/$($conflict.id)/action" @{action='accept'} $c.token
$null=CallApi POST "/api/requests/$($conflict.id)/action" @{action='confirm';originalSystemUpdated=$true;confirmationReference='CONFLICT'} $owner.token 409
$cancelReq=$request.Clone();$cancelReq.spaceId=2
$cancelled=CallApi POST /api/requests $cancelReq $b.token
$cancelled=CallApi POST "/api/requests/$($cancelled.id)/action" @{action='cancel'} $b.token
Check ($cancelled.status -eq 'cancelled') 'cancellation not persisted'
$null=CallApi POST /api/auth/logout @{} $c.token
$null=CallApi GET /api/me $null $c.token 401
# Store only temporary QA state for a server restart persistence check.
@{token=$b.token;requestId=$r.id;userId=$b.user.id} | ConvertTo-Json | Set-Content (Join-Path $DataRoot 'qa-state.json')
Write-Output "PASS: $script:Checks API and state checks; isolated QA data at $DataRoot"


