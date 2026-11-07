// The Grep tool's raw results, recorded from a live Claude Code session
// (claude -p, Haiku) by a PostToolUse hook on 2026-11-06 (spec 074 T001).
// The project held deploy/k8s.yaml (a k8s env entry), secrets/db_password,
// releases/2026-11-05/app-1-2.yaml and 'my app/c.yaml'; the hook's own log
// file also matched some searches. The scratch path is replaced by ${ROOT}.
// Facts: paths are relative to the working directory without ./ (even for
// an absolute path argument), -n is on by default, -- separates context
// groups, a one-file search prints N:/N- with no path, multiline marks every
// line a match, head_limit cuts lines silently (appliedLimit), and long lines
// are replaced by [Omitted long matching line].
export const GREP_FORMATS = {
  context: {
    input: { pattern: 'DB_PASSWORD', output_mode: 'content', '-A': 1 },
    result: {
      mode: 'content',
      numFiles: 0,
      filenames: [],
      content:
        'deploy/k8s.yaml:2:  - name: DB_PASSWORD\ndeploy/k8s.yaml-3-    value: Qx7mKpLzRvNwTyB',
      numLines: 2,
      totalLines: 2,
    },
  },
  contextNoNumbers: {
    input: { pattern: 'DB_PASSWORD', output_mode: 'content', '-A': 1, '-n': false },
    result: {
      mode: 'content',
      numFiles: 0,
      filenames: [],
      content:
        'grep-log.jsonl:[Omitted long matching line]\ngrep-log.jsonl-\n--\ndeploy/k8s.yaml:  - name: DB_PASSWORD\ndeploy/k8s.yaml-    value: Qx7mKpLzRvNwTyB',
      numLines: 5,
      totalLines: 5,
    },
  },
  subdirectory: {
    input: { pattern: 'password', path: 'releases', output_mode: 'content' },
    result: {
      mode: 'content',
      numFiles: 0,
      filenames: [],
      content: 'releases/2026-11-05/app-1-2.yaml:2:password: Xk9mQ2vL7ZpQwR',
      numLines: 1,
      totalLines: 1,
    },
  },
  oneFile: {
    input: { pattern: 'DB_PASSWORD', path: 'deploy/k8s.yaml', output_mode: 'content', '-A': 1 },
    result: {
      mode: 'content',
      numFiles: 0,
      filenames: [],
      content: '2:  - name: DB_PASSWORD\n3-    value: Qx7mKpLzRvNwTyB',
      numLines: 2,
      totalLines: 2,
    },
  },
  absoluteDirectory: {
    input: { pattern: 'DB_PASSWORD', path: '${ROOT}', output_mode: 'content' },
    result: {
      mode: 'content',
      numFiles: 0,
      filenames: [],
      content:
        'grep-log.jsonl:1:[Omitted long matching line]\ngrep-log.jsonl:3:[Omitted long matching line]\ngrep-log.jsonl:7:[Omitted long matching line]\ndeploy/k8s.yaml:2:  - name: DB_PASSWORD',
      numLines: 4,
      totalLines: 4,
    },
  },
  multiline: {
    input: { pattern: 'name:.*\\n.*value', output_mode: 'content', multiline: true },
    result: {
      mode: 'content',
      numFiles: 0,
      filenames: [],
      content:
        'grep-log.jsonl:1:[Omitted long matching line]\ngrep-log.jsonl:2:\ngrep-log.jsonl:3:[Omitted long matching line]\ngrep-log.jsonl:4:\ngrep-log.jsonl:5:[Omitted long matching line]\ngrep-log.jsonl:6:\ngrep-log.jsonl:7:[Omitted long matching line]\ndeploy/k8s.yaml:2:  - name: DB_PASSWORD\ndeploy/k8s.yaml:3:    value: Qx7mKpLzRvNwTyB\ndeploy/k8s.yaml:4:  - name: MODE\ndeploy/k8s.yaml:5:    value: prod',
      numLines: 11,
      totalLines: 11,
    },
  },
  headLimit: {
    input: { pattern: 'password|value|name', output_mode: 'content', '-i': true, head_limit: 2 },
    result: {
      mode: 'content',
      numFiles: 0,
      filenames: [],
      content:
        'grep-log.jsonl:1:[Omitted long matching line]\ngrep-log.jsonl:3:[Omitted long matching line]',
      numLines: 2,
      totalLines: 12,
      appliedLimit: 2,
    },
  },
  secretFile: {
    input: { pattern: 'hunter', output_mode: 'content' },
    result: {
      mode: 'content',
      numFiles: 0,
      filenames: [],
      content: 'secrets/db_password:1:hunter2hunter2',
      numLines: 1,
      totalLines: 1,
    },
  },
} as const
