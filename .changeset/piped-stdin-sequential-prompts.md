---
'@veilio-inc/cli': patch
---

Read piped stdin correctly across sequential prompts.

`veilio login` asks for an email and then a password. Given piped input it
consumed the whole stream on the first prompt, so the second saw nothing and the
command exited 0 having done nothing at all — the worst shape a failure can
take, because a script checking the exit code concludes it worked.

Prompts now take one line each from the stream. The regression got past a test
suite that mocked stdin rather than piping to a real process, so the fix ships
with a test that spawns the binary and pipes to it.
