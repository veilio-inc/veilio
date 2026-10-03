// Payloads recorded from a live Claude Code 2.1.288 session (Haiku 4.5) by a
// logging mod: each tool.call's event and what Claude Code resolved it to, and
// the prompt events. Local paths, the account's email and session ids were
// replaced. The fixture project is in ../live/project: src/ledger.ts holds the
// canary class QuasarLedgerReconciler, and .env a fake Stripe key.
export type Recorded = { kind: string; data: { e: any; r?: any } }
export const RECORDED: Recorded[] = [
  {
    kind: 'prompt.context',
    data: {
      e: {
        blocks: [
          {
            name: 'claudeMd',
            text: 'Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.\n\nContents of /work/project/CLAUDE.md (project instructions, checked into the codebase):\n\n# Project\nThe QuasarLedgerReconciler lives in src/ledger.ts.',
          },
          {
            name: 'userEmail',
            text: "The user's email address is developer@example.com. Use it only to identify the user, such as for authorship, attribution, or filtering their own work. Never send it to an unrelated service, such as in a request header, URL, or payload, unless the user explicitly asks.",
          },
          {
            name: 'currentDate',
            text: "Today's date is 2026-10-03.",
          },
        ],
        instructionFiles: [
          {
            path: '/work/project/CLAUDE.md',
            kind: 'project',
            content: '# Project\nThe QuasarLedgerReconciler lives in src/ledger.ts.\n',
          },
        ],
      },
      r: {
        blocks: [
          {
            name: 'claudeMd',
            text: 'Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.\n\nContents of /work/project/CLAUDE.md (project instructions, checked into the codebase):\n\n# Project\nThe QuasarLedgerReconciler lives in src/ledger.ts.',
          },
          {
            name: 'userEmail',
            text: "The user's email address is developer@example.com. Use it only to identify the user, such as for authorship, attribution, or filtering their own work. Never send it to an unrelated service, such as in a request header, URL, or payload, unless the user explicitly asks.",
          },
          {
            name: 'currentDate',
            text: "Today's date is 2026-10-03.",
          },
        ],
        instructionFiles: [
          {
            path: '/work/project/CLAUDE.md',
            kind: 'project',
            content: '# Project\nThe QuasarLedgerReconciler lives in src/ledger.ts.\n',
          },
        ],
      },
    },
  },
  {
    kind: 'prompt.submit',
    data: {
      e: {
        text: "Do each step in order, one tool call per step: 1) Read src/ledger.ts. 2) Read src/ledger.ts again. 3) Run: grep -rn Reconciler src notes.md 4) Run: ls /nonexistent-dir 5) Grep for 'settled' with output_mode content. 6) Grep for 'Ledger' with output_mode files_with_matches. 7) Glob 'src/**/*.ts'. 8) Edit src/ledger.ts replacing 'settledTotal' with 'closedTotal' (all occurrences). 9) Edit src/ledger.ts replacing 'doesNotExistXYZ' with 'x'. 10) Write a new file src/extra.ts with content 'export const quasarExtra = 1'. 11) Write src/extra.ts again with content 'export const quasarExtra = 2'. 12) Call the veilio MCP tool anonymize_text with text 'class QuasarLedgerReconciler {}'. 13) Use the Agent/Task tool to launch a general-purpose subagent with the prompt 'Read notes.md and reply with its first word'. 14) Run in the background: sleep 1 && echo bgdone. Then reply DONE.",
        wait: false,
        origin: {
          kind: 'sdk',
        },
      },
    },
  },
  {
    kind: 'prompt.attachment',
    data: {
      e: {
        type: 'environment',
        text: '# Environment\nYou have been invoked in the following environment: \n - Primary working directory: /work/project\n - Is a git repository: true\n - Platform: darwin\n - Shell: zsh\n - OS Version: Darwin 25.6.0',
        origin: {
          kind: 'engine',
        },
      },
      r: {
        text: '# Environment\nYou have been invoked in the following environment: \n - Primary working directory: /work/project\n - Is a git repository: true\n - Platform: darwin\n - Shell: zsh\n - OS Version: Darwin 25.6.0',
      },
    },
  },
  {
    kind: 'prompt.attachment',
    data: {
      e: {
        type: 'model',
        text: 'You are powered by the model named Haiku 4.5. The exact model ID is claude-haiku-4-5-20251001. Assistant knowledge cutoff is February 2025.',
        origin: {
          kind: 'engine',
        },
      },
      r: {
        text: 'You are powered by the model named Haiku 4.5. The exact model ID is claude-haiku-4-5-20251001. Assistant knowledge cutoff is February 2025.',
      },
    },
  },
  {
    kind: 'prompt.attachment',
    data: {
      e: {
        type: 'instructions',
        text: 'Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.\n\nContents of /work/project/CLAUDE.md (project instructions, checked into the codebase):\n\n# Project\nThe QuasarLedgerReconciler lives in src/ledger.ts.',
        origin: {
          kind: 'engine',
        },
      },
      r: {
        text: 'Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.\n\nContents of /work/project/CLAUDE.md (project instructions, checked into the codebase):\n\n# Project\nThe QuasarLedgerReconciler lives in src/ledger.ts.',
      },
    },
  },
  {
    kind: 'prompt.attachment',
    data: {
      e: {
        type: 'session_context',
        text: "As you answer the user's questions, you can use the following context:\n# userEmail\nThe user's email address is developer@example.com. Use it only to identify the user, such as for authorship, attribution, or filtering their own work. Never send it to an unrelated service, such as in a request header, URL, or payload, unless the user explicitly asks.\n# gitStatus\nThis is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.\n\nCurrent branch: main\n\nMain branch (you will usually use this for PRs): main\n\nGit user: Igor Dlugosh\n\nStatus:\n(clean)\n\nRecent commits:\nc7e6a02 init\n\nClaude Code attached this context automatically; it isn't part of the user's message. It describes the user's own account and workspace, so they don't need it reported back.",
        origin: {
          kind: 'engine',
        },
      },
      r: {
        text: "As you answer the user's questions, you can use the following context:\n# userEmail\nThe user's email address is developer@example.com. Use it only to identify the user, such as for authorship, attribution, or filtering their own work. Never send it to an unrelated service, such as in a request header, URL, or payload, unless the user explicitly asks.\n# gitStatus\nThis is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.\n\nCurrent branch: main\n\nMain branch (you will usually use this for PRs): main\n\nGit user: Igor Dlugosh\n\nStatus:\n(clean)\n\nRecent commits:\nc7e6a02 init\n\nClaude Code attached this context automatically; it isn't part of the user's message. It describes the user's own account and workspace, so they don't need it reported back.",
      },
    },
  },
  {
    kind: 'prompt.attachment',
    data: {
      e: {
        type: 'date',
        text: "Today's date is 2026-10-03.",
        origin: {
          kind: 'engine',
        },
      },
      r: {
        text: "Today's date is 2026-10-03.",
      },
    },
  },
  {
    kind: 'tool.call',
    data: {
      e: {
        file_path: '/work/project/src/ledger.ts',
        tool: 'Read',
        tool_use_id: 'toolu_014XAYGjRi51M37u2kha45DH',
      },
      r: {
        ref: 1,
        result: {
          type: 'text',
          file: {
            filePath: '/work/project/src/ledger.ts',
            content:
              'export class QuasarLedgerReconciler {\n  reconcile(batchEntries: string[]): number {\n    const settledTotal = batchEntries.length\n    return settledTotal\n  }\n}\n',
            numLines: 7,
            startLine: 1,
            totalLines: 7,
          },
        },
        text: '1\texport class QuasarLedgerReconciler {\n2\t  reconcile(batchEntries: string[]): number {\n3\t    const settledTotal = batchEntries.length\n4\t    return settledTotal\n5\t  }\n6\t}\n7\t',
        isReadOnly: true,
      },
    },
  },
  {
    kind: 'tool.call',
    data: {
      e: {
        file_path: '/work/project/src/ledger.ts',
        tool: 'Read',
        tool_use_id: 'toolu_01CaDMoVkacHiE3ntkRfVYhe',
      },
      r: {
        ref: 1,
        result: {
          type: 'text',
          file: {
            filePath: '/work/project/src/ledger.ts',
            content:
              'export class QuasarLedgerReconciler {\n  reconcile(batchEntries: string[]): number {\n    const settledTotal = batchEntries.length\n    return settledTotal\n  }\n}\n',
            numLines: 7,
            startLine: 1,
            totalLines: 7,
          },
        },
        text: '1\texport class QuasarLedgerReconciler {\n2\t  reconcile(batchEntries: string[]): number {\n3\t    const settledTotal = batchEntries.length\n4\t    return settledTotal\n5\t  }\n6\t}\n7\t',
        isReadOnly: true,
      },
    },
  },
  {
    kind: 'tool.call',
    data: {
      e: {
        command: 'grep -rn Reconciler src notes.md',
        description: 'Search for Reconciler in src and notes.md',
        tool: 'Bash',
        tool_use_id: 'toolu_01HVgaA7fN9EuDbWnc482VsR',
      },
      r: {
        ref: 1,
        result: {
          stdout:
            'src/ledger.ts:1:export class QuasarLedgerReconciler {\nnotes.md:1:QuasarLedgerReconciler is our ledger class.',
          stderr: '',
          interrupted: false,
          isImage: false,
          noOutputExpected: false,
        },
        text: 'src/ledger.ts:1:export class QuasarLedgerReconciler {\nnotes.md:1:QuasarLedgerReconciler is our ledger class.',
        isReadOnly: true,
      },
    },
  },
  {
    kind: 'tool.call',
    data: {
      e: {
        command: 'ls /nonexistent-dir',
        description: 'List nonexistent directory',
        tool: 'Bash',
        tool_use_id: 'toolu_01FwuLwqHiC5JcgWP4mxxAHv',
      },
      r: {
        ref: 1,
        result: 'Error: Exit code 1\nls: /nonexistent-dir: No such file or directory',
        text: 'Exit code 1\nls: /nonexistent-dir: No such file or directory',
        isError: true,
        isReadOnly: true,
      },
    },
  },
  {
    kind: 'tool.call',
    data: {
      e: {
        pattern: 'settled',
        output_mode: 'content',
        tool: 'Grep',
        tool_use_id: 'toolu_01JEvxAYsiDpGDy6DEmMx7Nk',
      },
      r: {
        ref: 1,
        result: {
          mode: 'content',
          numFiles: 0,
          filenames: [],
          content:
            'src/ledger.ts:3:    const settledTotal = batchEntries.length\nsrc/ledger.ts:4:    return settledTotal',
          numLines: 2,
          totalLines: 2,
        },
        text: 'src/ledger.ts:3:    const settledTotal = batchEntries.length\nsrc/ledger.ts:4:    return settledTotal',
        isReadOnly: true,
      },
    },
  },
  {
    kind: 'prompt.attachment',
    data: {
      e: {
        type: 'task_reminder',
        text: "The task tools haven't been used recently. If you're working on tasks that would benefit from tracking progress, consider using TaskCreate to add new tasks and TaskUpdate to update task status (set to in_progress when starting, completed when done). Also consider cleaning up the task list if it has become stale. Only use these if relevant to the current work. This is just a gentle reminder - ignore if not applicable.\n",
        origin: {
          kind: 'engine',
        },
      },
      r: {
        text: "The task tools haven't been used recently. If you're working on tasks that would benefit from tracking progress, consider using TaskCreate to add new tasks and TaskUpdate to update task status (set to in_progress when starting, completed when done). Also consider cleaning up the task list if it has become stale. Only use these if relevant to the current work. This is just a gentle reminder - ignore if not applicable.\n",
      },
    },
  },
  {
    kind: 'tool.call',
    data: {
      e: {
        pattern: 'Ledger',
        output_mode: 'files_with_matches',
        tool: 'Grep',
        tool_use_id: 'toolu_01LkDkfgDyJBveajgZSRSAXs',
      },
      r: {
        ref: 1,
        result: {
          mode: 'files_with_matches',
          filenames: ['CLAUDE.md', 'notes.md', 'src/ledger.ts'],
          numFiles: 3,
          totalFiles: 3,
        },
        text: 'Found 3 files\nCLAUDE.md\nnotes.md\nsrc/ledger.ts',
        isReadOnly: true,
      },
    },
  },
  {
    kind: 'tool.call',
    data: {
      e: {
        pattern: 'src/**/*.ts',
        tool: 'Glob',
        tool_use_id: 'toolu_01UkPvaqYhvp9WSDiQiety1q',
      },
      r: {
        ref: 1,
        result: {
          filenames: ['src/ledger.ts'],
          durationMs: 11,
          numFiles: 1,
          truncated: false,
          totalMatches: 1,
          countIsComplete: true,
        },
        text: 'src/ledger.ts',
        isReadOnly: true,
      },
    },
  },
  {
    kind: 'tool.call',
    data: {
      e: {
        replace_all: false,
        file_path: '/work/project/src/ledger.ts',
        old_string:
          'export class QuasarLedgerReconciler {\n  reconcile(batchEntries: string[]): number {\n    const settledTotal = batchEntries.length\n    return settledTotal\n  }\n}',
        new_string:
          'export class QuasarLedgerReconciler {\n  reconcile(batchEntries: string[]): number {\n    const closedTotal = batchEntries.length\n    return closedTotal\n  }\n}',
        tool: 'Edit',
        tool_use_id: 'toolu_01RGTYmX2eqUmCwmYo65Uk83',
      },
      r: {
        ref: 1,
        result: {
          filePath: '/work/project/src/ledger.ts',
          oldString:
            'export class QuasarLedgerReconciler {\n  reconcile(batchEntries: string[]): number {\n    const settledTotal = batchEntries.length\n    return settledTotal\n  }\n}',
          newString:
            'export class QuasarLedgerReconciler {\n  reconcile(batchEntries: string[]): number {\n    const closedTotal = batchEntries.length\n    return closedTotal\n  }\n}',
          originalFile:
            'export class QuasarLedgerReconciler {\n  reconcile(batchEntries: string[]): number {\n    const settledTotal = batchEntries.length\n    return settledTotal\n  }\n}\n',
          structuredPatch: [
            {
              oldStart: 1,
              oldLines: 6,
              newStart: 1,
              newLines: 6,
              lines: [
                ' export class QuasarLedgerReconciler {',
                '   reconcile(batchEntries: string[]): number {',
                '-    const settledTotal = batchEntries.length',
                '-    return settledTotal',
                '+    const closedTotal = batchEntries.length',
                '+    return closedTotal',
                '   }',
                ' }',
              ],
            },
          ],
          userModified: false,
          replaceAll: false,
        },
        text: 'The file /work/project/src/ledger.ts has been updated successfully. (file state is current in your context \u2014 no need to Read it back)',
      },
    },
  },
  {
    kind: 'tool.call',
    data: {
      e: {
        replace_all: false,
        file_path: '/work/project/src/ledger.ts',
        old_string: 'doesNotExistXYZ',
        new_string: 'x',
        tool: 'Edit',
        tool_use_id: 'toolu_01MLQDyGoqgkm17ktPkmMeup',
      },
      r: {
        ref: 1,
        result: 'Error: String to replace not found in file.\nString: doesNotExistXYZ',
        text: '<tool_use_error>String to replace not found in file.\nString: doesNotExistXYZ</tool_use_error>',
        isError: true,
      },
    },
  },
  {
    kind: 'tool.call',
    data: {
      e: {
        file_path: '/work/project/src/extra.ts',
        content: 'export const quasarExtra = 1',
        tool: 'Write',
        tool_use_id: 'toolu_01DMkzqvAuYSkcyhnabYh6vh',
      },
      r: {
        ref: 1,
        result: {
          type: 'create',
          filePath: '/work/project/src/extra.ts',
          content: 'export const quasarExtra = 1',
          structuredPatch: [],
          originalFile: null,
          userModified: false,
        },
        text: 'File created successfully at: /work/project/src/extra.ts (file state is current in your context \u2014 no need to Read it back)',
      },
    },
  },
  {
    kind: 'prompt.attachment',
    data: {
      e: {
        type: 'task_reminder',
        text: "The task tools haven't been used recently. If you're working on tasks that would benefit from tracking progress, consider using TaskCreate to add new tasks and TaskUpdate to update task status (set to in_progress when starting, completed when done). Also consider cleaning up the task list if it has become stale. Only use these if relevant to the current work. This is just a gentle reminder - ignore if not applicable.\n",
        origin: {
          kind: 'engine',
        },
      },
      r: {
        text: "The task tools haven't been used recently. If you're working on tasks that would benefit from tracking progress, consider using TaskCreate to add new tasks and TaskUpdate to update task status (set to in_progress when starting, completed when done). Also consider cleaning up the task list if it has become stale. Only use these if relevant to the current work. This is just a gentle reminder - ignore if not applicable.\n",
      },
    },
  },
  {
    kind: 'tool.call',
    data: {
      e: {
        file_path: '/work/project/src/extra.ts',
        content: 'export const quasarExtra = 2',
        tool: 'Write',
        tool_use_id: 'toolu_01SJ2yZNb3V8hWnHGsxvA4Yw',
      },
      r: {
        ref: 1,
        result: {
          type: 'update',
          filePath: '/work/project/src/extra.ts',
          content: 'export const quasarExtra = 2',
          structuredPatch: [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: [
                '-export const quasarExtra = 1',
                '\\ No newline at end of file',
                '+export const quasarExtra = 2',
                '\\ No newline at end of file',
              ],
            },
          ],
          originalFile: 'export const quasarExtra = 1',
          userModified: false,
        },
        text: 'The file /work/project/src/extra.ts has been updated successfully. (file state is current in your context \u2014 no need to Read it back)',
      },
    },
  },
  {
    kind: 'tool.call',
    data: {
      e: {
        query: 'select:mcp__veilio__anonymize_text',
        tool: 'ToolSearch',
        tool_use_id: 'toolu_01FYWhSLvP6e3nt9eMbWvbjA',
      },
      r: {
        ref: 1,
        result: {
          matches: ['mcp__veilio__anonymize_text'],
          query: 'select:mcp__veilio__anonymize_text',
          total_deferred_tools: 23,
        },
        text: '',
        isReadOnly: true,
      },
    },
  },
  {
    kind: 'tool.call',
    data: {
      e: {
        text: 'class QuasarLedgerReconciler {}',
        tool: 'mcp__veilio__anonymize_text',
        tool_use_id: 'toolu_011HeSEmZHxNApgubU5VvC14',
      },
      r: {
        ref: 1,
        result: [
          {
            type: 'text',
            text: 'Source: inline text\nLanguage: TypeScript / JavaScript\nPlaceholders in map: 1\nNamespace: local\nCustom rules: none\nNo credentials detected.\nWARNING: no language marker matched. Masked as TypeScript / JavaScript, which may be wrong for this file \u2014 pass "language" explicitly to be sure.\n\n--- masked code ---\nclass __CLS__1 {}',
          },
        ],
        text: 'Source: inline text\nLanguage: TypeScript / JavaScript\nPlaceholders in map: 1\nNamespace: local\nCustom rules: none\nNo credentials detected.\nWARNING: no language marker matched. Masked as TypeScript / JavaScript, which may be wrong for this file \u2014 pass "language" explicitly to be sure.\n\n--- masked code ---\nclass __CLS__1 {}',
      },
    },
  },
  {
    kind: 'prompt.attachment',
    data: {
      e: {
        type: 'environment',
        text: '# Environment\nYou have been invoked in the following environment: \n - Primary working directory: /work/project\n - Is a git repository: true\n - Platform: darwin\n - Shell: zsh\n - OS Version: Darwin 25.6.0',
        origin: {
          kind: 'engine',
        },
        agentId: 'aa2a5fe66977cc4b4',
      },
      r: {
        text: '# Environment\nYou have been invoked in the following environment: \n - Primary working directory: /work/project\n - Is a git repository: true\n - Platform: darwin\n - Shell: zsh\n - OS Version: Darwin 25.6.0',
      },
    },
  },
  {
    kind: 'prompt.attachment',
    data: {
      e: {
        type: 'model',
        text: 'You are powered by the model named Haiku 4.5. The exact model ID is claude-haiku-4-5-20251001. Assistant knowledge cutoff is February 2025.',
        origin: {
          kind: 'engine',
        },
        agentId: 'aa2a5fe66977cc4b4',
      },
      r: {
        text: 'You are powered by the model named Haiku 4.5. The exact model ID is claude-haiku-4-5-20251001. Assistant knowledge cutoff is February 2025.',
      },
    },
  },
  {
    kind: 'prompt.attachment',
    data: {
      e: {
        type: 'instructions',
        text: 'Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.\n\nContents of /work/project/CLAUDE.md (project instructions, checked into the codebase):\n\n# Project\nThe QuasarLedgerReconciler lives in src/ledger.ts.',
        origin: {
          kind: 'engine',
        },
        agentId: 'aa2a5fe66977cc4b4',
      },
      r: {
        text: 'Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.\n\nContents of /work/project/CLAUDE.md (project instructions, checked into the codebase):\n\n# Project\nThe QuasarLedgerReconciler lives in src/ledger.ts.',
      },
    },
  },
  {
    kind: 'prompt.attachment',
    data: {
      e: {
        type: 'session_context',
        text: "As you answer the user's questions, you can use the following context:\n# userEmail\nThe user's email address is developer@example.com. Use it only to identify the user, such as for authorship, attribution, or filtering their own work. Never send it to an unrelated service, such as in a request header, URL, or payload, unless the user explicitly asks.\n# gitStatus\nThis is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.\n\nCurrent branch: main\n\nMain branch (you will usually use this for PRs): main\n\nGit user: Igor Dlugosh\n\nStatus:\nM src/ledger.ts\n?? src/extra.ts\n\nRecent commits:\nc7e6a02 init\n\nClaude Code attached this context automatically; it isn't part of the user's message. It describes the user's own account and workspace, so they don't need it reported back.",
        origin: {
          kind: 'engine',
        },
        agentId: 'aa2a5fe66977cc4b4',
      },
      r: {
        text: "As you answer the user's questions, you can use the following context:\n# userEmail\nThe user's email address is developer@example.com. Use it only to identify the user, such as for authorship, attribution, or filtering their own work. Never send it to an unrelated service, such as in a request header, URL, or payload, unless the user explicitly asks.\n# gitStatus\nThis is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.\n\nCurrent branch: main\n\nMain branch (you will usually use this for PRs): main\n\nGit user: Igor Dlugosh\n\nStatus:\nM src/ledger.ts\n?? src/extra.ts\n\nRecent commits:\nc7e6a02 init\n\nClaude Code attached this context automatically; it isn't part of the user's message. It describes the user's own account and workspace, so they don't need it reported back.",
      },
    },
  },
  {
    kind: 'prompt.attachment',
    data: {
      e: {
        type: 'date',
        text: "Today's date is 2026-10-03.",
        origin: {
          kind: 'engine',
        },
        agentId: 'aa2a5fe66977cc4b4',
      },
      r: {
        text: "Today's date is 2026-10-03.",
      },
    },
  },
  {
    kind: 'tool.call',
    data: {
      e: {
        description: 'Read notes.md and report first word',
        prompt: 'Read notes.md and reply with its first word',
        tool: 'Agent',
        tool_use_id: 'toolu_01Pj36YxxUETPQTa3yqwuFve',
      },
      r: {
        ref: 1,
        result: {
          isAsync: true,
          status: 'async_launched',
          agentId: 'aa2a5fe66977cc4b4',
          description: 'Read notes.md and report first word',
          resolvedModel: 'claude-haiku-4-5-20251001',
          prompt: 'Read notes.md and reply with its first word',
          outputFile:
            '/tmp/claude/project-tasks/e47e772e-5ab0-41c5-ae4e-940f80872814/tasks/aa2a5fe66977cc4b4.output',
          canReadOutputFile: true,
        },
        text: "Async agent launched successfully. (This tool result is internal metadata \u2014 never quote or paste any part of it, including the agentId below, into a user-facing reply.)\nagentId: aa2a5fe66977cc4b4 (internal ID - do not mention to user. Use SendMessage with to: 'aa2a5fe66977cc4b4', summary: '<5-10 word recap>' to continue this agent.)\nThe agent is working in the background. You will be notified automatically when it completes. You know nothing about its results until that notification arrives \u2014 do not report, assume, or predict them; continue other work or respond to the user in the meantime.\nDo not duplicate this agent's work \u2014 avoid working with the same files or topics it is using.\noutput_file: /tmp/claude/project-tasks/e47e772e-5ab0-41c5-ae4e-940f80872814/tasks/aa2a5fe66977cc4b4.output\nDo NOT Read or tail this file via the shell tool \u2014 it is the full subagent JSONL transcript and reading it will overflow your context. If the user asks for progress, say the agent is still running; you'll get a completion notification.",
        isReadOnly: true,
      },
    },
  },
  {
    kind: 'tool.call',
    data: {
      e: {
        file_path: '/work/project/notes.md',
        tool: 'Read',
        tool_use_id: 'toolu_01Vk4xTWcJj2DLfCPgbHWaGx',
        agentId: 'aa2a5fe66977cc4b4',
      },
      r: {
        ref: 1,
        result: {
          type: 'text',
          file: {
            filePath: '/work/project/notes.md',
            content: 'QuasarLedgerReconciler is our ledger class.\n',
            numLines: 2,
            startLine: 1,
            totalLines: 2,
          },
        },
        text: '1\tQuasarLedgerReconciler is our ledger class.\n2\t',
        isReadOnly: true,
      },
    },
  },
  {
    kind: 'tool.call',
    data: {
      e: {
        command: 'sleep 1 && echo bgdone',
        description: 'Sleep and echo bgdone',
        run_in_background: true,
        tool: 'Bash',
        tool_use_id: 'toolu_01DQvZ2xKkpdoSAXUCQz4vyj',
      },
      r: {
        ref: 1,
        result: {
          stdout: '',
          stderr: '',
          interrupted: false,
          isImage: false,
          noOutputExpected: false,
          backgroundTaskId: 'b8jj7ps1c',
        },
        text: 'Command running in background with ID: b8jj7ps1c. Output is being written to: /tmp/claude/project-tasks/e47e772e-5ab0-41c5-ae4e-940f80872814/tasks/b8jj7ps1c.output. You will be notified when it completes. To check interim output, use Read on that file path.',
        isReadOnly: true,
      },
    },
  },
  {
    kind: 'prompt.submit',
    data: {
      e: {
        text: '<task-notification>\n<task-id>b8jj7ps1c</task-id>\n<tool-use-id>toolu_01DQvZ2xKkpdoSAXUCQz4vyj</tool-use-id>\n<output-file>/tmp/claude/project-tasks/e47e772e-5ab0-41c5-ae4e-940f80872814/tasks/b8jj7ps1c.output</output-file>\n<status>completed</status>\n<summary>Background command "Sleep and echo bgdone" completed (exit code 0)</summary>\n</task-notification>',
        wait: false,
        origin: {
          kind: 'task-notification',
        },
      },
    },
  },
  {
    kind: 'prompt.submit',
    data: {
      e: {
        text: '<task-notification>\n<task-id>aa2a5fe66977cc4b4</task-id>\n<tool-use-id>toolu_01Pj36YxxUETPQTa3yqwuFve</tool-use-id>\n<output-file>/tmp/claude/project-tasks/e47e772e-5ab0-41c5-ae4e-940f80872814/tasks/aa2a5fe66977cc4b4.output</output-file>\n<status>completed</status>\n<summary>Agent "Read notes.md and report first word" finished</summary>\n<note>A task-notification fires each time this agent stops with no live background children of its own. The user can send it another message and resume it, so the same task-id may notify more than once.</note>\n<result>The first word from notes.md is **QuasarLedgerReconciler**.</result>\n<usage><subagent_tokens>17215</subagent_tokens><tool_uses>1</tool_uses><duration_ms>5951</duration_ms></usage>\n</task-notification>',
        wait: false,
        origin: {
          kind: 'task-notification',
        },
      },
    },
  },
  {
    kind: 'prompt.attachment',
    data: {
      e: {
        type: 'task_reminder',
        text: "The task tools haven't been used recently. If you're working on tasks that would benefit from tracking progress, consider using TaskCreate to add new tasks and TaskUpdate to update task status (set to in_progress when starting, completed when done). Also consider cleaning up the task list if it has become stale. Only use these if relevant to the current work. This is just a gentle reminder - ignore if not applicable.\n",
        origin: {
          kind: 'engine',
        },
      },
      r: {
        text: "The task tools haven't been used recently. If you're working on tasks that would benefit from tracking progress, consider using TaskCreate to add new tasks and TaskUpdate to update task status (set to in_progress when starting, completed when done). Also consider cleaning up the task list if it has become stale. Only use these if relevant to the current work. This is just a gentle reminder - ignore if not applicable.\n",
      },
    },
  },
]
