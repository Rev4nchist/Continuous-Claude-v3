# PowerShell walker for shell-ast.mjs: stdin text -> one JSON object (commands with element kinds, assignments, comments, errors, node kinds).
# Run as: pwsh -NoProfile -NonInteractive -File shell-ast-walk.ps1   (text on stdin, so no command-line length limit).
# The JSON is ASCII only (EscapeNonAscii), so the console encoding cannot damage it. Offsets are UTF-16 code units (JS string indexes).
# With -Batch the stdin is a JSON array of texts and the output is one JSON line per text (one pwsh process for a corpus).
param([switch]$Batch)
$ErrorActionPreference = 'Stop'
$enc = [System.Text.UTF8Encoding]::new($false)
$reader = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), $enc)
$AL = 'System.Management.Automation.Language.'
function IsA($n, $name) { $n.GetType().Name -eq $name }
$LOOPS = @('ForEachStatementAst', 'ForStatementAst', 'WhileStatementAst', 'DoWhileStatementAst', 'DoUntilStatementAst')

function ElemOf($el) {
  $s = $el.Extent.StartOffset; $e = $el.Extent.EndOffset
  $t = $el.GetType().Name
  if ($t -eq 'StringConstantExpressionAst') { return @{ k = 'lit'; v = [string]$el.Value; s = $s; e = $e; st = [string]$el.StringConstantType } }
  if ($t -eq 'ConstantExpressionAst') { return @{ k = 'lit'; v = $el.Extent.Text; s = $s; e = $e } }
  if ($t -eq 'VariableExpressionAst') { return @{ k = 'var'; var = $el.VariablePath.UserPath; splat = [bool]$el.Splatted; s = $s; e = $e } }
  if ($t -eq 'ExpandableStringExpressionAst') { return ExpandableOf $el $s $e }
  if ($t -eq 'SubExpressionAst' -or $t -eq 'ParenExpressionAst') { return @{ k = 'subexpr'; s = $s; e = $e } }
  if ($t -eq 'ScriptBlockExpressionAst') { return @{ k = 'scriptblock'; s = $s; e = $e } }
  return @{ k = 'other'; t = $t; s = $s; e = $e }
}

function ExpandableOf($el, $s, $e) {
  $nested = @($el.NestedExpressions)
  foreach ($n in $nested) { if ($n.GetType().Name -eq 'SubExpressionAst') { return @{ k = 'cmdsubst'; s = $s; e = $e } } }
  if ($nested.Count -eq 1 -and (IsA $nested[0] 'VariableExpressionAst') -and $el.Value.Trim() -eq $nested[0].Extent.Text) {
    return @{ k = 'var'; var = $nested[0].VariablePath.UserPath; splat = $false; quoted = $true; s = $s; e = $e }
  }
  $rel = $nested[0].Extent.StartOffset - $s - 1
  $pre = if ($rel -gt 0 -and $rel -le $el.Value.Length) { $el.Value.Substring(0, $rel) } else { '' }
  return @{ k = 'expandable'; prefix = $pre; s = $s; e = $e }
}

function CtxOf($c) {
  $depth = 0; $func = $null; $pipe = $false; $chain = $null; $bg = $false
  $n = $c
  while ($n.Parent) {
    $p = $n.Parent; $pt = $p.GetType().Name
    if ($pt -eq 'PipelineAst') { if ($p.PipelineElements.Count -gt 1) { $pipe = $true }; if ($p.Background) { $bg = $true } }
    elseif ($pt -eq 'PipelineChainAst') {
      if ($p.Background) { $bg = $true }
      if ($null -eq $chain -and [object]::ReferenceEquals($n, $p.RhsPipeline)) { $chain = if ($p.Operator.ToString() -eq 'AndAnd') { '&&' } else { '||' } }
    }
    elseif ($pt -eq 'SubExpressionAst' -or $pt -eq 'ScriptBlockExpressionAst' -or $LOOPS -contains $pt) { $depth++ }
    elseif ($pt -eq 'FunctionDefinitionAst') { $depth++; if (-not $func) { $func = $p.Name } }
    elseif (($pt -eq 'NamedBlockAst' -or $pt -eq 'StatementBlockAst') -and $null -eq $chain) {
      if ([array]::IndexOf(@($p.Statements), $n) -gt 0) { $chain = ';' }
    }
    $n = $p
  }
  return @{ depth = $depth; func = $func; pipe = $pipe; chain = $chain; bg = $bg }
}

function IsTop($a) {
  $n = $a.Parent
  while ($n) {
    $t = $n.GetType().Name
    if ($t -ne 'NamedBlockAst' -and $t -ne 'ScriptBlockAst' -and $t -ne 'StatementBlockAst') { return $false }
    $n = $n.Parent
  }
  return $true
}

function Walk([string]$text) {
$tokens = $null; $errs = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$errs)
$cmds = New-Object System.Collections.ArrayList
foreach ($c in $ast.FindAll({ param($n) $n.GetType().Name -eq 'CommandAst' }, $true)) {
  $els = New-Object System.Collections.ArrayList
  foreach ($el in $c.CommandElements) {
    if ((IsA $el 'CommandParameterAst')) {
      [void]$els.Add(@{ k = 'param'; v = '-' + $el.ParameterName; s = $el.Extent.StartOffset; e = $el.Extent.EndOffset })
      if ($el.Argument) { $x = ElemOf $el.Argument; $x.colon = $true; [void]$els.Add($x) }
    } else { [void]$els.Add((ElemOf $el)) }
  }
  $ctx = CtxOf $c
  $op = switch ($c.InvocationOperator.ToString()) { 'Ampersand' { '&' } 'Dot' { '.' } default { $null } }
  [void]$cmds.Add(@{ s = $c.Extent.StartOffset; e = $c.Extent.EndOffset; op = $op; depth = $ctx.depth; func = $ctx.func; pipe = $ctx.pipe; chain = $ctx.chain; bg = $ctx.bg; els = $els })
}

$assigns = New-Object System.Collections.ArrayList
foreach ($a in $ast.FindAll({ param($n) $n.GetType().Name -eq 'AssignmentStatementAst' }, $true)) {
  $l = $a.Left
  if ((IsA $l 'ConvertExpressionAst')) { $l = $l.Child }
  if (-not (IsA $l 'VariableExpressionAst')) { continue }
  $lit = $null
  if ($a.Operator.ToString() -eq 'Equals' -and (IsA $a.Right 'CommandExpressionAst')) {
    $x = $a.Right.Expression
    if ((IsA $x 'StringConstantExpressionAst')) { $lit = [string]$x.Value } elseif ((IsA $x 'ConstantExpressionAst')) { $lit = $x.Extent.Text }
  }
  [void]$assigns.Add(@{ name = $l.VariablePath.UserPath; lit = $lit; end = $a.Extent.EndOffset; top = (IsTop $a); s = $a.Extent.StartOffset })
}
foreach ($f in $ast.FindAll({ param($n) $n.GetType().Name -eq 'ForEachStatementAst' }, $true)) {
  [void]$assigns.Add(@{ name = $f.Variable.VariablePath.UserPath; lit = $null; end = $f.Extent.StartOffset; top = $false; s = $f.Extent.StartOffset })
}
foreach ($p in $ast.FindAll({ param($n) $n.GetType().Name -eq 'ParameterAst' }, $true)) {
  [void]$assigns.Add(@{ name = $p.Name.VariablePath.UserPath; lit = $null; end = $p.Extent.StartOffset; top = $false; s = $p.Extent.StartOffset })
}

# Ranges for the coderabbit guard (coord-guard-shell-parser commit 2): content of each quoted string and here-string, here-string bodies, and each $( ) span
# with a flag for "inside a double-quoted string". Read from AST extents only; the quote characters themselves are outside the content range.
$quoted = New-Object System.Collections.ArrayList
$bodies = New-Object System.Collections.ArrayList
foreach ($q in $ast.FindAll({ param($n) $t = $n.GetType().Name; $t -eq 'StringConstantExpressionAst' -or $t -eq 'ExpandableStringExpressionAst' }, $true)) {
  $st = [string]$q.StringConstantType
  $qs = $q.Extent.StartOffset; $qe = $q.Extent.EndOffset
  if ($st -eq 'SingleQuotedHereString' -or $st -eq 'DoubleQuotedHereString') {
    # The closing @' or @" starts a line: the body ends at the line break before it (e - 3), the opener line break (s + 2) is part of the body.
    [void]$quoted.Add(@{ s = $qs + 2; e = $qe - 3 }); [void]$bodies.Add(@{ s = $qs + 2; e = $qe - 3 })
  } elseif ($st -eq 'SingleQuoted' -or $st -eq 'DoubleQuoted') {
    [void]$quoted.Add(@{ s = $qs + 1; e = $qe - 1 })
  }
}
$substs = New-Object System.Collections.ArrayList
foreach ($x in $ast.FindAll({ param($n) $n.GetType().Name -eq 'SubExpressionAst' }, $true)) {
  $dq = $false; $pp = $x.Parent
  while ($pp) { if ($pp.GetType().Name -eq 'ExpandableStringExpressionAst') { $dq = $true; break }; $pp = $pp.Parent }
  [void]$substs.Add(@{ s = $x.Extent.StartOffset; e = $x.Extent.EndOffset; dq = $dq })
}

$comments = @(foreach ($t in $tokens) { if ($t.Kind.ToString() -eq 'Comment') { @{ s = $t.Extent.StartOffset; e = $t.Extent.EndOffset } } })
$errors = @(foreach ($x in $errs) { @{ offset = $x.Extent.StartOffset; msg = [string]$x.Message } })
$kinds = @($ast.FindAll({ $true }, $true) | ForEach-Object { $_.GetType().Name } | Sort-Object -Unique)

return @{ errors = $errors; cmds = @($cmds); assigns = @($assigns); comments = $comments; kinds = $kinds; quoted = @($quoted); bodies = @($bodies); substs = @($substs) }
}

function ToJson($o) { $o | ConvertTo-Json -Compress -Depth 20 -EscapeHandling EscapeNonAscii }
if ($Batch) {
  $texts = $reader.ReadToEnd() | ConvertFrom-Json -NoEnumerate
  foreach ($t in $texts) {
    try { [Console]::Out.WriteLine((ToJson (Walk ([string]$t)))) } catch { [Console]::Out.WriteLine((ToJson @{ fatal = 'walker error' }))  }
  }
} else {
  [Console]::Out.Write((ToJson (Walk $reader.ReadToEnd())))
}
