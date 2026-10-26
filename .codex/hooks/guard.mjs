let input = "";
for await (const chunk of process.stdin) input += chunk;

function deny(reason) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `Blocked: ${reason}`,
    },
  }));
}

let event;
try {
  event = JSON.parse(input || "{}");
} catch {
  deny("invalid policy input");
  process.exit(0);
}

const toolInput = event.tool_input;
const command = typeof toolInput === "string"
  ? toolInput
  : String(toolInput?.command ?? toolInput?.cmd ?? toolInput?.patch ?? "");

const rules = [
  [/\brm\s+(?:-[^\s|;]*r[^\s|;]*|--recursive)\b|Remove-Item\b[^|;\r\n]*-Recurse\b|\b(rd|rmdir|del)(?:\.exe)?\b[^|;\r\n]*\/s\b/i, "recursive delete"],
  [/\bgit(?:\.exe)?\s+push\b[^|;\r\n]*(?:--force(?:-with-lease)?\b|\s-f\b)|\bgit(?:\.exe)?\s+reset\s+--hard\b|\bgit(?:\.exe)?\s+clean\s+-\w*f/i, "destructive git"],
  [/\b(curl|wget|iwr|irm|Invoke-WebRequest)(?:\.exe)?\b[^\r\n]*\|\s*(sh|bash|iex|Invoke-Expression|powershell|pwsh)\b/i, "pipe to shell"],
  [/^\*\*\* (Add|Update|Delete) File: .*\.env(?!\.example(?:$|\s))\b/m, "patch .env"],
  [/(>|Set-Content|Add-Content|Out-File|Copy-Item|Move-Item|Remove-Item|New-Item)[^|;\r\n]*\.env(?!\.example(?:$|[\s"']))\b/i, "write .env"],
  [/\bgit(?:\.exe)?\s+add\b[^|;\r\n]*\s(-f|--force)\b/i, "force-add ignored files"],
  [/\bgit(?:\.exe)?\s+(commit|push)\b[^|;\r\n]*\s(--no-verify|-n)\b/i, "skip git hooks"],
  [/\bgit(?:\.exe)?\s+config\b[^|;\r\n]*core\.hooksPath/i, "change git hooks path"],
  [/(>|Set-Content|Add-Content|Out-File|Copy-Item|Move-Item|Remove-Item|New-Item)[^|;\r\n]*\.git[\\/]/i, "write inside .git"],
  [/^\*\*\* (Add|Update|Delete) File: .*\.git[\\/]/m, "patch inside .git"],
];

const match = rules.find(([pattern]) => pattern.test(command));
if (match) deny(match[1]);
