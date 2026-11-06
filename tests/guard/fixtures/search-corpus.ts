// Spec 074 T003: the comparison corpus for search output - every Grep fixture
// of the plugin tests, the e72 ship-check probes (the session's probes/, sc2/
// and sc3/, copied as they were run), each format of research R1, and the edge
// cases of the spec. Every value is a fake made for these tests.
// Stripe-shaped fakes are split (`'sk_' + 'test_…'`) so push protection does not take them for keys.
//
// A case is a project (`files`, created on disk under a fresh root, `${ROOT}`
// in any string replaced by it), one search result (`content`: the Grep tool's
// content, or a Bash command's stdout) and optionally a later Bash stdout
// (`later`), to show what the search taught the session.
import { GREP_FORMATS } from '../../../plugins/veilio-guard/tests/fixtures/grep-formats.ts'

export type CorpusCase = {
  name: string
  tool: 'Grep' | 'Bash'
  /** The Grep tool's input, or `{ command }` for Bash. */
  args: Record<string, unknown>
  content: string
  files?: Record<string, string>
  later?: string
}

// ── the e72 probes, as run ──────────────────────────────────────────────────
// grep_*: Grep contents; pair_*: [Grep content, later stdout]; text_*: [a
// file's text, later stdout]; file_*: { path | command, a: the file's text,
// b: later stdout }.
const RAW: Record<string, unknown[]> = {
  grep_g1: [
    '1:localhost:5432:*:postgres:Xq9mK2pLzRvNw7',
    'localhost:5432:*:postgres:Xq9mK2pLzRvNw7',
    '1:db.internal:5432:app:admin:Wb4nR8tLq2XzKm\n2:db.internal:5432:app:report:Pz6vT1yHq8LmNc',
    '/home/u/proj/deploy/db.pgpass:1:localhost:5432:*:postgres:Xq9mK2pLzRvNw7',
    '3:DB_PASSWORD=Qx7mKpL9zRvNwTyB',
    '3:  password: Qx7m:12:KpL9zRvNwTyB',
  ],
  grep_g2: [
    'localhost:5432:*:postgres:correcthorse!9',
    'localhost:5432:*:postgres:s3cr3t-pa55',
    'db.prod.internal:5432:billing:billing_rw:Tr0ub4dor&3',
    'localhost:5432:*:postgres:x9q2m7kz4w',
    'localhost:5432:*:postgres:hunter2hunter2',
    '3:spring.datasource.url=jdbc:oracle:thin:scott/Xq9mK2pL@db.prod:1521:ORCL',
    'spring.datasource.url=jdbc:oracle:thin:scott/Xq9mK2pL@db.prod:1521:ORCL',
    '3:REDIS_PASSWORD=abc:12:hunter2hunter2',
    '3:DB_PASSWORD=pa:55:word-2026!',
  ],
  grep_g3: [
    '1:localhost:5432:*:postgres:correcthorse!9',
    '1:localhost:5432:*:postgres:hunter2hunter2',
    "deploy/pgpass.conf:localhost:5432:*:postgres:hunter2hunter2\nsrc/db.ts:const host = 'localhost'",
    "deploy/pgpass.conf:1:localhost:5432:*:postgres:hunter2hunter2\nsrc/db.ts:4:const host = 'localhost'",
    'ops/notes.md:psql via localhost:5432:*:postgres:hunter2hunter2',
  ],
  grep_g5: [
    '12:{"ts":"10:00:00","password":"hunter2hunter2"}',
    '12:{"ts":"10:00:00","password":"Xq9mK2pLzRvNw7"}',
    '12:2026-11-06T10:00:00Z login user=bob password=hunter2hunter2',
    '12:[10:00:00] DB_PASSWORD="hunter2hunter2"',
    '12:10:00:00 api_key: sk_' + 'test_51HxQ2pLzRvNw7Xq9mK2',
    '12:at 10:00:00 "secret": "correct-horse-9"',
    "12:  started: '10:15:30'  password: 'Tr0ub4dor&3'",
    'app.log:12:{"ts":"10:00:00","password":"hunter2hunter2"}',
  ],
  grep_g6: [
    'logs/app.log:{"ts":"10:00:00","password":"hunter2hunter2"}\nsrc/a.ts:x',
    'logs/app.log:{"ts":"10:00:00","password":"Tr0ub4dor&3xyz"}\nsrc/a.ts:x',
    'logs/app.log:10:00:01 auth password=correcthorse!9\nsrc/a.ts:x',
    'logs/app.log:{"ts":"10:00:00","token":"ghp_x9Kq2LmZ7vRt4Wp8nB3cD5eF6gH7iJ8kL9m"}',
    'deploy/hosts.txt:db1 10.0.0.5:5432:prod password correcthorse!9',
  ],
  grep_g7: [
    '3:echo "localhost:5432:*:postgres:hunter2hunter2" >> ~/.pgpass',
    'scripts/setup.sh:echo "localhost:5432:*:postgres:hunter2hunter2" >> ~/.pgpass\nsrc/a.ts:x',
    'C:\\Users\\me\\AppData\\Roaming\\postgresql\\pgpass.conf:localhost:5432:*:postgres:Tr0ub4dor&3\nsrc/a.ts:x',
    'localhost:5432:*:postgres:Tr0ub4dor&3',
  ],
  grep_g8: [
    'secrets/db_password:1:hunter2hunter2\nsrc/a.ts:1:x',
    'secrets/db_password.txt:1:correcthorse!9\nsrc/a.ts:1:x',
    '/run/secrets/api_token:1:Tr0ub4dor&3xyz\nsrc/a.ts:1:x',
    'deploy/secrets/postgres_password:1:Xq9mK2pLzRvNw7\nsrc/a.ts:1:x',
    'secrets/db_password.txt:hunter2hunter2\nsrc/a.ts:x',
  ],
  pair_t1: [
    [
      '/r/.env:3:SECRET_NAME=prod-db-creds-2026\n/r/src/a.ts:1:x',
      'kubectl get secret prod-db-creds-2026',
    ],
    ['/r/.env:3:API_KEY_HEADER=X-Api-Key-V2\n/r/src/a.ts:1:x', 'curl -H X-Api-Key-V2'],
    [
      '/r/.env:3:AUTH_TOKEN_URL=https://auth.example.com/oauth2/token\n/r/src/a.ts:1:x',
      'POST https://auth.example.com/oauth2/token',
    ],
    [
      '/r/.env:3:PASSWORD_RESET_PATH=/account/reset-password-v2\n/r/src/a.ts:1:x',
      'GET /account/reset-password-v2',
    ],
    [
      '/r/deploy/app.yaml:3:  passwordSecret: argocd-repo-creds-x7k\n/r/src/a.ts:1:x',
      'kubectl get secret argocd-repo-creds-x7k',
    ],
    [
      '/r/deploy/app.yaml:3:  secret: release-build-2026-x9\n/r/src/a.ts:1:x',
      'git tag release-build-2026-x9',
    ],
    [
      '/r/.env:3:GIT_TOKEN_SHA=9b74c9897bac770ffc029102a200c5de\n/r/src/a.ts:1:x',
      'commit 9b74c9897bac770ffc029102a200c5de',
    ],
    ['/r/.env:3:DEPLOY_PASSWORD=Xq9mK2pLzRvNw7\n/r/src/a.ts:1:x', 'Xq9mK2pLzRvNw7'],
  ],
  pair_t4: [
    ['4:    self.secret_key = rotateKeyV2Xq9', 'def rotateKeyV2Xq9(self):\n'],
    ['4:    api_token = buildTokenFromVault2', 'x = buildTokenFromVault2()\n'],
    ['12:SECRET_KEY = DjangoSecretLoader2026', 'DjangoSecretLoader2026\n'],
    ['7:  password = PasswordHasherV3', 'class PasswordHasherV3:\n'],
    [
      '4:    self.secret_key = rotateKeyV2Xq9\n9:    return self.secret_key',
      'def rotateKeyV2Xq9(self):\n',
    ],
    ['src/app.py:4:    self.secret_key = rotateKeyV2Xq9', 'def rotateKeyV2Xq9(self):\n'],
  ],
  pair_t5: [
    ['    self.secret_key = rotateKeyV2Xq9', 'def rotateKeyV2Xq9(self):\n'],
    ['SECRET_KEY = DjangoSecretLoader2026', 'DjangoSecretLoader2026\n'],
    ['src/app.py:    self.secret_key = rotateKeyV2Xq9\nsrc/b.py:x', 'def rotateKeyV2Xq9(self):\n'],
    ['src/settings.py:SECRET_KEY = DjangoSecretLoader2026\nsrc/b.py:x', 'DjangoSecretLoader2026\n'],
  ],
  pair_t6: [
    ['12:client = Client(api_key=apiKeyFromVaultV2)', 'def apiKeyFromVaultV2():\n'],
    [
      '12:    conn = psycopg2.connect(host=h, password=dbPasswordV2Xq)',
      "dbPasswordV2Xq = os.environ['X']\n",
    ],
    [
      'src/db.py:12:    conn = psycopg2.connect(host=h, password=dbPasswordV2Xq)\nsrc/b.py:1:x',
      "dbPasswordV2Xq = os.environ['X']\n",
    ],
  ],
  text_t2: [
    [
      '{"value": [], "@odata.deltaLink": "x", "deltaToken": "MzE0NDA5ODQ0OTQ3NDkxMg"}\n',
      'saved MzE0NDA5ODQ0OTQ3NDkxMg to state.json\n',
    ],
    [
      '{"items": [], "prevToken": "eyJvZmZzZXQiOjIwfQ", "nextPageToken": "eyJvZmZzZXQiOjQwfQ"}\n',
      'cursor eyJvZmZzZXQiOjIwfQ eyJvZmZzZXQiOjQwfQ\n',
    ],
    [
      '{"skipToken": "X1RQX2NvbnRpbnVhdGlvbg2"}\n',
      'GET /v1.0/users?page=X1RQX2NvbnRpbnVhdGlvbg2\n',
    ],
    ['{"ResumptionToken": "oai1700000000x9k2"}\n', 'harvest oai1700000000x9k2\n'],
    [
      '<input name="__RequestVerificationToken" type="hidden" value="CfDJ8Mx7Kq2nQ9pLz3RvWt" />\n',
      '<meta content="CfDJ8Mx7Kq2nQ9pLz3RvWt">\n',
    ],
    [
      'authenticity_token=Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA&commit=Save\n',
      'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA\n',
    ],
  ],
  text_t3: [
    [
      '{"deltaToken": "MzE0NDA5ODQ0OTQ3NDkxMg=="}\n',
      'saved MzE0NDA5ODQ0OTQ3NDkxMg== to state.json\n',
    ],
    ['{"prevToken": "eyJvZmZzZXQiOjIwfQ=="}\n', 'cursor=eyJvZmZzZXQiOjIwfQ==\n'],
    ['{"skipToken": "m!1!AQ-x7k2-9f3c"}\n', 'next m!1!AQ-x7k2-9f3c\n'],
    ['{"lockToken": "Xk9mQ2vL7ZpQwR8tYb3n/2"}\n', 'renew Xk9mQ2vL7ZpQwR8tYb3n/2\n'],
  ],
  text_c1: [
    [
      'existingSecret: postgres-credentials-7f9k2\n',
      'kubectl get secret postgres-credentials-7f9k2',
    ],
    ['tlsSecret: wildcard-tls-prod2026\n', 'secret wildcard-tls-prod2026 created'],
    ['passwordSecret: argocd-repo-creds-x7k\n', 'argocd-repo-creds-x7k ok'],
    ["password: <%= ENV['DB_PASSWORD'] %>\n", "value <%= ENV['DB_PASSWORD'] %> here"],
    [
      '{"ClientRequestToken": "Console-CreateStack-8f2a9c1e-4b7d-4e2a-9f3c-1a2b3c4d5e6f"}\n',
      '| Console-CreateStack-8f2a9c1e-4b7d-4e2a-9f3c-1a2b3c4d5e6f |',
    ],
    [
      '{"nextForwardToken": "f/38270347288712048975349756372945813508467329123456789012/s"}\n',
      'f/38270347288712048975349756372945813508467329123456789012/s',
    ],
    [
      '{"uploadSequenceToken": "49590338271490256608559692538361571095921575989136588898"}\n',
      'seq 49590338271490256608559692538361571095921575989136588898',
    ],
    [
      'authenticity_token=Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA&commit=Save\n',
      'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA',
    ],
    ['secret_key_base: 3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c\n', '3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c'],
    ['password_hash: 5f4dcc3b5aa765d61d8327deb882cf99\n', 'md5 5f4dcc3b5aa765d61d8327deb882cf99'],
    [
      'password: 5f4dcc3b5aa765d61d8327deb882cf99\n',
      'commit 5f4dcc3b5aa765d61d8327deb882cf99 at HEAD',
    ],
    [
      'token_secret: sha256:9b74c9897bac770ffc029102a200c5de\n',
      'image sha256:9b74c9897bac770ffc029102a200c5de',
    ],
    [
      'DB_PASSWORD=Xq9mK2pL,Host=db.internal.example.com;Port=5432\n',
      'connect db.internal.example.com 5432',
    ],
    [
      'DATABASE_URL=Server=db.prod.example.com;Database=app;Password=Xq9mK2pLzR;User Id=sa\n',
      'db.prod.example.com app sa Database=app',
    ],
    ['secret: v1.2.3-rc4\n', 'release v1.2.3-rc4'],
    ['password: /run/secrets/db_password\n', 'cat /run/secrets/db_password'],
    ['api_key: ~/.config/acme/api_key.txt\n', 'cat ~/.config/acme/api_key.txt'],
    ['SECRET_KEY=django-insecure-abc\n', 'x'],
    [
      'password: my-service-account@project-123.iam.gserviceaccount.com\n',
      'my-service-account@project-123.iam.gserviceaccount.com',
    ],
    ['access_key: AKIAIOSFODNN7EXAMPLE,AKIAI44QH8DHBEXAMPLE\n', 'AKIAI44QH8DHBEXAMPLE'],
    ['api_token: abc,def,https://api.example.com/v2\n', 'https://api.example.com/v2'],
    ['password: Xq9mK2pL;host=10.0.0.12;user=deploy-bot\n', 'ssh deploy-bot@10.0.0.12'],
    ['SECRET_TOKEN=ab12;cd34ef;main-branch-2026\n', 'git checkout main-branch-2026'],
  ],
  text_c2: [
    [
      '<input name="__RequestVerificationToken" type="hidden" value="CfDJ8Mx7Kq2nQ9pLz3RvWt" />\n',
      '<meta content="CfDJ8Mx7Kq2nQ9pLz3RvWt">',
    ],
    [
      '<input type="hidden" name="authenticity_token" value="Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA">\n',
      '<meta name="csrf-token" content="Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA">',
    ],
    [
      '{"authenticity_token": "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA"}\n',
      '<meta name="csrf-token" content="Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA">',
    ],
    ['{"deltaToken": "Xk9mQ2vL7ZpQwR8tYb3n"}\n', 'Xk9mQ2vL7ZpQwR8tYb3n'],
    [
      '{"lockToken": "8f2a9c1e-4b7d-4e2a-9f3c-1a2b3c4d5e6f"}\n',
      'message 8f2a9c1e-4b7d-4e2a-9f3c-1a2b3c4d5e6f',
    ],
    ['{"skipToken": "Xk9mQ2vL7ZpQwR8tYb3n"}\n', 'Xk9mQ2vL7ZpQwR8tYb3n'],
    ['{"paging_token": "Xk9mQ2vL7ZpQwR8tYb3n"}\n', 'Xk9mQ2vL7ZpQwR8tYb3n'],
    ['{"ResumptionToken": "Xk9mQ2vL7ZpQwR8tYb3n"}\n', 'Xk9mQ2vL7ZpQwR8tYb3n'],
    ['{"after_token": "Xk9mQ2vL7ZpQwR8tYb3n"}\n', 'Xk9mQ2vL7ZpQwR8tYb3n'],
    ['{"scroll_token": "Xk9mQ2vL7ZpQwR8tYb3n"}\n', 'Xk9mQ2vL7ZpQwR8tYb3n'],
    ['{"nextPageToken": "Xk9mQ2vL7ZpQwR8tYb3n"}\n', 'Xk9mQ2vL7ZpQwR8tYb3n'],
    [
      '{"ClientToken": "8f2a9c1e-4b7d-4e2a-9f3c-1a2b3c4d5e6f"}\n',
      'instance 8f2a9c1e-4b7d-4e2a-9f3c-1a2b3c4d5e6f',
    ],
    ['{"lockToken": "Xk9mQ2vL7ZpQwR8tYb3n"}\n', 'Xk9mQ2vL7ZpQwR8tYb3n'],
    ['{"cancellationToken": "Xk9mQ2vL7ZpQwR8tYb3n"}\n', 'Xk9mQ2vL7ZpQwR8tYb3n'],
    ['{"etagToken": "Xk9mQ2vL7ZpQwR8tYb3n"}\n', 'Xk9mQ2vL7ZpQwR8tYb3n'],
    ['{"previousToken": "Xk9mQ2vL7ZpQwR8tYb3n"}\n', 'Xk9mQ2vL7ZpQwR8tYb3n'],
    ['{"prevToken": "Xk9mQ2vL7ZpQwR8tYb3n"}\n', 'Xk9mQ2vL7ZpQwR8tYb3n'],
    ['{"continueToken": "Xk9mQ2vL7ZpQwR8tYb3n"}\n', 'Xk9mQ2vL7ZpQwR8tYb3n'],
    ['{"pageToken": "Xk9mQ2vL7ZpQwR8tYb3n"}\n', 'Xk9mQ2vL7ZpQwR8tYb3n'],
    ['{"requestToken": "Xk9mQ2vL7ZpQwR8tYb3n"}\n', 'Xk9mQ2vL7ZpQwR8tYb3n'],
    ['{"passwordSecret": "argocd-repo-creds-x7k"}\n', 'argocd-repo-creds-x7k'],
    ['adminPasswordSecret: grafana-admin-2026\n', 'kubectl get secret grafana-admin-2026'],
    ['secret: release-2026-11-06\n', 'git tag release-2026-11-06'],
    ['apiKeySecret: datadog-api-key-v2\n', 'kubectl get secret datadog-api-key-v2'],
    ['PASSWORD: deploy-bot-2026\n', 'ssh deploy-bot-2026@host'],
    ['token_secret: xk2_build_7f9a\n', 'xk2_build_7f9a'],
  ],
  text_c3: [
    [
      '{"skipToken": "X1RQX2NvbnRpbnVhdGlvbg2"}\n',
      'GET /v1.0/users?page=X1RQX2NvbnRpbnVhdGlvbg2 HTTP/1.1',
    ],
    [
      '{"deltaToken": "MzE0NDA5ODQ0OTQ3NDkxMg"}\n',
      'stored delta MzE0NDA5ODQ0OTQ3NDkxMg in sync_state.json',
    ],
    ['{"paging_token": "12884905984-1", "id": "12884905984-1"}\n', 'op 12884905984-1'],
    ['{"prevToken": "eyJvZmZzZXQiOjIwfQ"}\n', 'cursor eyJvZmZzZXQiOjIwfQ'],
    [
      '{"continueToken": "eyJ2IjoibWV0YS5rOHMuaW8vdjEiLCJydiI6MTIzNDV9"}\n',
      'eyJ2IjoibWV0YS5rOHMuaW8vdjEiLCJydiI6MTIzNDV9',
    ],
    ['NEXT_PAGE=1&skip_token=Ab3dE6gH9jK2mN5p\n', 'Ab3dE6gH9jK2mN5p'],
  ],
  text_c4: [
    ['password: Xq9mK2pLzR,db-primary-01.internal\n', 'ssh db-primary-01.internal'],
    ['api_token: Tk9mQ2vL7Zp;deploy-bot-2026\n', 'user deploy-bot-2026'],
    ['api_key: Ak9mQ2vL7ZpQ,v2.14.3-beta.7\n', 'release v2.14.3-beta.7'],
    ['SECRET_TOKEN=Tk9mQ2vL7Zp,a3f9c2e1b7d4f6a8\n', 'commit a3f9c2e1b7d4f6a8'],
    ['API_KEY=Ak9mQ2vL7ZpQ&format=json&callback=handleResponse_v2\n', 'handleResponse_v2'],
    [
      'https://api.example.com/v1/data?api_key=Ak9mQ2vL7ZpQ&cursor=c3Vic2NyaXB0aW9u&region=eu-west-1\n',
      'cursor c3Vic2NyaXB0aW9u',
    ],
    [
      'DB_PASSWORD=Xq9mK2pLzR;ConnectTimeout30;ApplicationName=billing-worker-v2\n',
      'billing-worker-v2',
    ],
    ['password: Xq9mK2pLzR,MyCompanyProdCluster\n', 'MyCompanyProdCluster'],
    ['secret_key: Sk9mQ2vL7ZpQ,src/config/settings_prod.py\n', 'src/config/settings_prod.py'],
  ],
  text_bb1: [
    [
      'spec:\n  template:\n    metadata:\n      annotations:\n        checksum/secret: 8f3d2a9c41b7e6f05d1c3a8b9e2f4d6c7a1b0e3f5d8c2a4b6e9f1d3c5a7b8e0f\n',
      'pod annotation 8f3d2a9c41b7e6f05d1c3a8b9e2f4d6c7a1b0e3f5d8c2a4b6e9f1d3c5a7b8e0f',
    ],
    [
      'DB_PASSWORD=PROD_DB_PASSWORD_V2\n',
      'export PROD_DB_PASSWORD_V2=x; echo $PROD_DB_PASSWORD_V2',
    ],
    ['api_key: OPENAI_API_KEY_2\n', "os.environ['OPENAI_API_KEY_2']"],
    ['password: POSTGRES_PASSWORD_PROD\n', 'POSTGRES_PASSWORD_PROD is unset'],
    ['db.password=ENC(Xq9mK2pLzRvNw7Ab)\n', 'see ENC(Xq9mK2pLzRvNw7Ab)'],
    ['{"ResultToken": "Qx7mKpL9zRvNwTyB4hJ2eyJ"}', 'token Qx7mKpL9zRvNwTyB4hJ2eyJ'],
  ],
  text_bb2: [
    [
      'app:\n  password: SECRET_KEY_V2\n',
      'export SECRET_KEY_V2=abc; python -c \'import os; os.environ["SECRET_KEY_V2"]\'',
    ],
    ['db:\n  password: db-password-v2\n', 'kubectl create secret generic db-password-v2'],
  ],
  text_bb3: [
    ['ci:\n  password: GITHUB_TOKEN_CI2\n', "token = os.environ['GITHUB_TOKEN_CI2']"],
    ['API_TOKEN=STRIPE_SECRET_KEY_2\n', 'echo $STRIPE_SECRET_KEY_2'],
    ['  api_key: OPENAI_API_KEY2\n', 'export OPENAI_API_KEY2=...'],
    ['  password: DB_PASSWORD2\n', 'DB_PASSWORD2 unset'],
  ],
  text_bb4: [
    ['ci:\n  password: GITHUB_TOKEN_CI2\n', 'if [ -z "$GITHUB_TOKEN_CI2" ]; then exit 1; fi'],
    ['ci:\n  password: SECRET_KEY_V2\n', 'grep -rn SECRET_KEY_V2 app/ found 3 uses'],
  ],
  text_bb5: [
    [
      '{\n  "ClientToken": "terraform-20241105123456789000000001",\n  "InstanceId": "i-0abc"\n}',
      'instance launched by terraform-20241105123456789000000001',
    ],
    [
      '{\n  "ClientToken": "a1f3c9e2-7b4d-4e8a-9c21-5d6f0b3e8a71"\n}',
      'idempotency a1f3c9e2-7b4d-4e8a-9c21-5d6f0b3e8a71 reused',
    ],
    ['{\n  "ClientToken": "myapp-run-v2-9f8e7d"\n}', 'run myapp-run-v2-9f8e7d'],
  ],
  file_c1: [
    {
      command: 'aws ec2 describe-instances',
      a: '{\n  "ClientToken": "a1f3c9e2-7b4d-4e8a-9c21-5d6f0b3e8a71",\n  "InstanceId": "i-0abc"\n}',
      b: 'tag ref a1f3c9e2-7b4d-4e8a-9c21-5d6f0b3e8a71 in the log',
    },
    {
      command: 'aws logs get-log-events',
      a: '{"nextForwardToken": "Qx7mKpL9zRvNwTyB4hJ2"}',
      b: 'use Qx7mKpL9zRvNwTyB4hJ2 next',
    },
    {
      path: '/r/values.yaml',
      a: 'auth:\n  existingSecret: pg-creds-x7k2q9\n',
      b: 'kubectl get secret pg-creds-x7k2q9',
    },
    {
      path: '/r/deploy/app.yaml',
      a: '  passwordSecret: argocd-repo-creds-x7k\n',
      b: 'kubectl get secret argocd-repo-creds-x7k',
    },
    {
      path: '/r/.env',
      a: 'DB_PASSWORD=Qx7mKpL9zRvNwTyB\n',
      b: 'psql with Qx7mKpL9zRvNwTyB',
    },
    {
      command: 'cat .env',
      a: 'DB_PASSWORD=Qx7mKpL9zRvNwTyB\n',
      b: 'psql with Qx7mKpL9zRvNwTyB',
    },
  ],
  file_d1: [
    {
      command: 'cat docker-compose.yml',
      a: 'services:\n  db:\n    environment:\n      POSTGRES_PASSWORD: db_password_v2\n',
      b: 'docker secret inspect db_password_v2',
    },
    {
      command: 'cat values.yaml',
      a: 'auth:\n  password: Prod-DB-Password-2\n',
      b: 'kubectl get secret Prod-DB-Password-2',
    },
    {
      command: 'cat app.yaml',
      a: 'db:\n  password: prod/myapp/db-password\n',
      b: 'aws secretsmanager get-secret-value --secret-id prod/myapp/db-password',
    },
    {
      command: 'cat app.yaml',
      a: 'db:\n  password: arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/db-AbCdEf\n',
      b: 'aws secretsmanager describe-secret --secret-id arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/db-AbCdEf',
    },
    {
      command: 'cat .env',
      a: 'DB_PASSWORD=op://Private/Postgres/password\n',
      b: 'op read op://Private/Postgres/password',
    },
    {
      command: 'cat app.yaml',
      a: 'db:\n  password: vault:secret/data/db#password\n',
      b: 'vault kv get secret/data/db',
    },
    {
      command: 'cat app.yaml',
      a: 'db:\n  password: ref+vault://secret/db#/password\n',
      b: 'vals eval ref+vault://secret/db#/password',
    },
    {
      command: 'cat app.yaml',
      a: 'db:\n  password: https://myvault.vault.azure.net/secrets/db-password\n',
      b: 'curl https://myvault.vault.azure.net/secrets/db-password',
    },
    {
      command: 'cat app.yaml',
      a: 'db:\n  password: projects/123456/secrets/dbPassword/versions/latest\n',
      b: 'gcloud secrets versions access latest --secret projects/123456/secrets/dbPassword/versions/latest',
    },
    {
      command: 'cat app.yaml',
      a: 'db:\n  password: "<your-db-password>"\n',
      b: 'replace <your-db-password> with yours',
    },
    {
      command: 'cat app.yaml',
      a: 'db:\n  password: your_password_here\n',
      b: 'replace your_password_here',
    },
    {
      command: 'cat app.yaml',
      a: 'db:\n  password: "********"\n',
      b: 'masked ********',
    },
    {
      command: 'cat app.yaml',
      a: 'api:\n  api_key: sk-xxxxxxxxxxxxxxxxxxxxxxxx\n',
      b: 'sk-xxxxxxxxxxxxxxxxxxxxxxxx',
    },
    {
      command: 'cat app.yaml',
      a: 'api:\n  api_key: YOUR_API_KEY_HERE\n',
      b: 'YOUR_API_KEY_HERE',
    },
    {
      command: 'cat app.yaml',
      a: 'db:\n  password: db.password.prod\n',
      b: 'spring property db.password.prod',
    },
    {
      command: 'cat app.yaml',
      a: 'db:\n  password: DbPasswordProd2\n',
      b: 'az keyvault secret show --name DbPasswordProd2',
    },
    {
      command: 'cat app.yaml',
      a: 'db:\n  password: !vault |\n          $ANSIBLE_VAULT;1.1;AES256\n          62313365396662343061393464336163383764373764613633653634306231386433626436623361\n',
      b: '62313365396662343061393464336163383764373764613633653634306231386433626436623361',
    },
    {
      command: 'cat app.yaml',
      a: "db:\n  password: \"{{ lookup('env', 'DB_PASS') }}\"\n",
      b: 'x',
    },
    {
      command: 'cat app.yaml',
      a: 'db:\n  password: "{{ vault_db_password_v2 }}"\n',
      b: 'vault_db_password_v2',
    },
    {
      command: 'cat app.yaml',
      a: 'db:\n  password: secretref:db-pass\n',
      b: 'secretref:db-pass',
    },
    {
      command: 'cat app.yaml',
      a: 'db:\n  password: file:/etc/secrets/dbpass\n',
      b: 'cat /etc/secrets/dbpass',
    },
    {
      command: 'cat app.yaml',
      a: 'db:\n  password: env:DB_PASSWORD_PROD\n',
      b: 'env:DB_PASSWORD_PROD',
    },
    {
      command: 'cat app.yaml',
      a: 'db:\n  password: ${{ secrets.DB_PASSWORD }}\n',
      b: 'x',
    },
    {
      command: 'cat .github/workflows/ci.yml',
      a: '      env:\n        API_TOKEN: secrets.API_TOKEN_PROD\n',
      b: 'secrets.API_TOKEN_PROD',
    },
    {
      command: 'cat app.yaml',
      a: 'db:\n  password: AQICAHhxyz12345ABCDEFGHijklmn\n',
      b: 'AQICAHhxyz12345ABCDEFGHijklmn',
    },
  ],
  file_d2: [
    {
      path: '/r/src/locales/en.json',
      a: '{\n  "newPassword": "New password (min. 12 characters)",\n  "apiKey": "Enter your API key"\n}',
      b: "<label>{t('New password (min. 12 characters)')}</label> Enter your API key",
    },
    {
      path: '/r/src/locales/en.json',
      a: '{\n  "password": "Password must be 8-64 characters, with 1 digit!"\n}',
      b: 'Password must be 8-64 characters, with 1 digit!',
    },
    {
      path: '/r/src/locales/en.json',
      a: '{\n  "accessToken": "Access token copied to clipboard."\n}',
      b: "toast('Access token copied to clipboard.')",
    },
    {
      path: '/r/src/locales/de.json',
      a: '{\n  "confirmPassword": "Passwort bestätigen"\n}',
      b: 'Passwort bestätigen',
    },
    {
      path: '/r/config/locales/en.yml',
      a: 'en:\n  devise:\n    password: "Forgot your password? Reset it here (link expires in 6h)."\n',
      b: 'Forgot your password? Reset it here (link expires in 6h).',
    },
    {
      path: '/r/src/messages.properties',
      a: 'user.password=Your password has expired, please choose a new one (2FA required)\n',
      b: 'Your password has expired, please choose a new one (2FA required)',
    },
    {
      path: '/r/src/i18n/en.ts',
      a: "export default {\n  apiKey: 'API Key (v2)',\n  secretKey: 'Secret Key / HMAC-SHA256',\n}\n",
      b: 'API Key (v2) and Secret Key / HMAC-SHA256',
    },
    {
      path: '/r/main.tf',
      a: 'resource "aws_db_instance" "db" {\n  password = var.DbMasterPasswordV2\n}\n',
      b: 'var.DbMasterPasswordV2',
    },
    {
      path: '/r/main.tf',
      a: '  password = data.aws_secretsmanager_secret_version.db.secret_string\n',
      b: 'data.aws_secretsmanager_secret_version.db.secret_string',
    },
    {
      path: '/r/app/settings.json',
      a: '{"ConnectionStrings": {}, "ApiKey": "@Microsoft.KeyVault(SecretUri=https://myvault.vault.azure.net/secrets/ApiKey/)"}',
      b: '@Microsoft.KeyVault(SecretUri=https://myvault.vault.azure.net/secrets/ApiKey/)',
    },
    {
      path: '/r/openapi.yaml',
      a: 'components:\n  securitySchemes:\n    api_key:\n      type: apiKey\n      name: X-Api-Key-V2\n',
      b: 'X-Api-Key-V2',
    },
    {
      path: '/r/openapi.yaml',
      a: '      parameters:\n        - name: token\n          example: eyJhbGciOiJIUzI1NiJ9\n',
      b: 'x',
    },
    {
      path: '/r/README.md',
      a: 'Set `API_KEY=<paste-from-Dashboard>` before running.\n',
      b: '<paste-from-Dashboard>',
    },
    {
      path: '/r/app.yaml',
      a: 'auth:\n  password: "Summer2026!"\n',
      b: 'Summer2026!',
    },
    {
      path: '/r/app.yaml',
      a: 'auth:\n  api_key: "${API_KEY}"\n  secret_key: "see 1Password: Prod/AWS"\n',
      b: 'see 1Password: Prod/AWS',
    },
  ],
  file_d3: [
    {
      command: 'cat app.yaml',
      a: 'db:\n  password: dbPasswordProd2\n',
      b: 'secret dbPasswordProd2',
    },
    {
      command: 'cat app.yaml',
      a: 'db:\n  password: PostgresAdminPassword\n',
      b: 'az keyvault secret show --name PostgresAdminPassword',
    },
    {
      command: 'cat app.yaml',
      a: 'db:\n  password: MyApp-DbPassword-Prod\n',
      b: 'MyApp-DbPassword-Prod',
    },
    {
      command: 'cat app.yaml',
      a: 'db:\n  password: db_password_prod_2026\n',
      b: 'db_password_prod_2026',
    },
    {
      command: 'cat app.yaml',
      a: 'kms:\n  encryption_key: arn:aws:kms:us-east-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab\n',
      b: 'aws kms describe-key --key-id arn:aws:kms:us-east-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab',
    },
    {
      command: 'cat app.yaml',
      a: 'kms:\n  encryption_key: 1234abcd-12ab-34cd-56ef-1234567890ab\n',
      b: 'aws kms describe-key --key-id 1234abcd-12ab-34cd-56ef-1234567890ab',
    },
    {
      command: 'cat .goreleaser.yml',
      a: 'signs:\n  - signing_key: 3AA5C34371567BD2\n',
      b: 'gpg --list-keys 3AA5C34371567BD2',
    },
    {
      command: 'cat deploy.yml',
      a: 'ssh:\n  private_key: /home/deploy/.ssh/id_ed25519_Prod2\n',
      b: 'chmod 600 /home/deploy/.ssh/id_ed25519_Prod2',
    },
    {
      command: 'cat app.yaml',
      a: 'vault:\n  secret_key: kv/data/Prod/DbPassword2\n',
      b: 'vault kv get kv/data/Prod/DbPassword2',
    },
    {
      command: 'cat docker-compose.yml',
      a: '    environment:\n      SECRET_KEY: AppSecretKeyV2\n',
      b: 'AppSecretKeyV2',
    },
    {
      command: 'cat .env',
      a: 'JWT_SECRET=ChangeMeInProduction2026\n',
      b: 'grep ChangeMeInProduction2026',
    },
    {
      command: 'cat .env.example',
      a: 'API_TOKEN=YourApiTokenHere123\n',
      b: 'YourApiTokenHere123',
    },
    {
      command: 'cat .env.example',
      a: 'STRIPE_SECRET_KEY=sk_' + 'test_XXXXXXXXXXXXXXXXXXXXXXXX\n',
      b: 'sk_' + 'test_XXXXXXXXXXXXXXXXXXXXXXXX',
    },
    {
      command: 'cat .env',
      a: 'SESSION_SECRET=2f7c9a1e-4b3d-4e8a-9c21-5d6f0b3e8a71\n',
      b: '2f7c9a1e-4b3d-4e8a-9c21-5d6f0b3e8a71',
    },
    {
      command: 'cat app.yaml',
      a: 'image:\n  pullSecret: RegistryPullSecret2\n',
      b: 'RegistryPullSecret2',
    },
    {
      command: 'cat app.yaml',
      a: '  tokenSecret: GithubAppTokenSecret\n',
      b: 'GithubAppTokenSecret',
    },
    {
      command: 'cat app.yaml',
      a: '  secretToken: MyWebhookSecretToken\n',
      b: 'MyWebhookSecretToken',
    },
    {
      command: 'cat values.yaml',
      a: '  existingSecret: PgCredsSecret2\n',
      b: 'kubectl get secret PgCredsSecret2',
    },
    {
      command: 'cat app.yaml',
      a: '  apiKey: UseVaultForThis\n',
      b: 'UseVaultForThis',
    },
  ],
  file_d4: [
    {
      command: 'aws codebuild batch-get-projects --names web',
      a: '{\n    "projects": [\n        {\n            "name": "web",\n            "encryptionKey": "arn:aws:kms:us-east-1:123456789012:alias/aws/s3",\n            "serviceRole": "arn:aws:iam::123456789012:role/cb"\n        }\n    ]\n}',
      b: 'aws kms describe-key arn:aws:kms:us-east-1:123456789012:alias/aws/s3',
    },
    {
      command: 'aws codebuild batch-get-projects --names web',
      a: '{"encryptionKey": "arn:aws:kms:eu-west-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab"}',
      b: 'key arn:aws:kms:eu-west-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab',
    },
    {
      path: '/r/template.yaml',
      a: 'Resources:\n  Build:\n    Type: AWS::CodeBuild::Project\n    Properties:\n      EncryptionKey: arn:aws:kms:us-east-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab\n',
      b: 'arn:aws:kms:us-east-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab',
    },
    {
      path: '/r/template.yaml',
      a: '      EncryptionKey: !GetAtt KmsKey.Arn\n',
      b: '!GetAtt KmsKey.Arn',
    },
    {
      command: 'aws signer get-signing-profile',
      a: '{"signingKey": "arn:aws:kms:us-east-1:123456789012:key/abcd1234-12ab-34cd-56ef-1234567890ab"}',
      b: 'arn:aws:kms:us-east-1:123456789012:key/abcd1234-12ab-34cd-56ef-1234567890ab',
    },
    {
      command: 'gcloud kms keys list',
      a: 'encryption_key: projects/my-proj-2026/locations/global/keyRings/ring1/cryptoKeys/Key2\n',
      b: 'projects/my-proj-2026/locations/global/keyRings/ring1/cryptoKeys/Key2',
    },
    {
      command: 'terraform show',
      a: '  encryption_key = "projects/my-proj-2026/locations/europe-west1/keyRings/app/cryptoKeys/bucketKey"\n',
      b: 'projects/my-proj-2026/locations/europe-west1/keyRings/app/cryptoKeys/bucketKey',
    },
    {
      path: '/r/main.tf',
      a: '  encryption_key = "arn:aws:kms:us-east-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab"\n',
      b: 'arn:aws:kms:us-east-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab',
    },
    {
      path: '/r/vars.yml',
      a: 'db:\n  password: postgres_admin_password_2026\n',
      b: 'ansible-vault view group_vars/postgres_admin_password_2026',
    },
    {
      command: 'cat docker-compose.yml',
      a: 'services:\n  db:\n    environment:\n      POSTGRES_PASSWORD: pg_superuser_secret_v12\n',
      b: 'docker secret create pg_superuser_secret_v12 ./pw.txt',
    },
    {
      command: 'cat app.yaml',
      a: 'db:\n  password: "projects/my-proj-2026/secrets/db-password/versions/3"\n',
      b: 'projects/my-proj-2026/secrets/db-password/versions/3',
    },
  ],
  file_d5: [
    {
      path: '/r/src/main/resources/mule.properties',
      a: 'db.password=![Xq9mK2pLzRvNw7AbQ1==]\n',
      b: 'see ![Xq9mK2pLzRvNw7AbQ1==]',
    },
    {
      command: 'cat sealed.yaml',
      a: 'apiVersion: bitnami.com/v1alpha1\nkind: SealedSecret\nspec:\n  encryptedData:\n    password: AgBy3i4OJSWK+PiTySYZZA9rO43cGDEq\n',
      b: 'AgBy3i4OJSWK+PiTySYZZA9rO43cGDEq',
    },
    {
      command: 'cat app.yaml',
      a: 'db:\n  password: AQICAHhxyz12345ABCDEFGHijklmnopqrstuvwxyz0123456789+/ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/AB==\n',
      b: 'AQICAHhxyz12345ABCDEFGHijklmnopqrstuvwxyz0123456789+/ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/AB==',
    },
    {
      command: 'cat app.properties',
      a: 'spring.datasource.password={noop}Xq9mK2pLzRvNw7\n',
      b: 'Xq9mK2pLzRvNw7',
    },
    {
      command: 'cat app.properties',
      a: 'db.password = ENC( Xq9mK2pLzRvNw7Ab )\n',
      b: 'ENC( Xq9mK2pLzRvNw7Ab )',
    },
    {
      command: 'cat app.properties',
      a: 'db.password=enc(Xq9mK2pLzRvNw7Ab)\n',
      b: 'enc(Xq9mK2pLzRvNw7Ab)',
    },
    {
      command: 'cat app.properties',
      a: 'db.password=DEC(Xq9mK2pLzRvNw7Ab)\n',
      b: 'DEC(Xq9mK2pLzRvNw7Ab)',
    },
    {
      command: 'cat app.properties',
      a: "db.password='ENC(Xq9mK2pLzRvNw7Ab)'\n",
      b: 'ENC(Xq9mK2pLzRvNw7Ab)',
    },
    {
      command: 'cat .env',
      a: 'DB_PASSWORD="ENC[AES256_GCM,data:Wb4nR8tLq2XzKm==,iv:Qx7mKpL9zRvNwTyB4hJ2aa==,tag:Pz6vT1yHq8LmNcXX==,type:str]"\n',
      b: 'iv:Qx7mKpL9zRvNwTyB4hJ2aa==',
    },
    {
      command: 'cat secrets.json',
      a: '{"password": "ENC[AES256_GCM,data:Wb4nR8tLq2XzKm==,iv:Qx7mKpL9zRvNwTyB4hJ2aa==,tag:Pz6vT1yHq8LmNcXX==,type:str]"}',
      b: 'tag:Pz6vT1yHq8LmNcXX==',
    },
    {
      command: 'cat app.yaml',
      a: 'db:\n  password: "{cipher}AQBx7mKpL9zRvNwTyB4hJ2"\n',
      b: 'AQBx7mKpL9zRvNwTyB4hJ2',
    },
    {
      command: 'cat app.yml',
      a: "  password: '{cipher}{key:prod}AQBx7mKpL9zRvNwTyB4hJ2'\n",
      b: '{key:prod}AQBx7mKpL9zRvNwTyB4hJ2',
    },
  ],
}

const STRONG = (i: number) => `Qx7mKpLz${'RvNwTyBhJdFgSc'.slice(i % 7, (i % 7) + 6)}${i}T`
const lines = (text: string) => text.replace(/\n$/, '').split('\n')
/** Every line of a file as `grep -rn ''` prints it. */
const numbered = (path: string, text: string) =>
  lines(text)
    .map((l, i) => `${path}:${i + 1}:${l}`)
    .join('\n')
const grep = (
  name: string,
  content: string,
  files: Record<string, string> = {},
  args: Record<string, unknown> = {},
  later?: string
): CorpusCase => ({
  name,
  tool: 'Grep',
  args: { pattern: 'password', output_mode: 'content', ...args },
  content,
  files,
  ...(later !== undefined ? { later } : {}),
})
const bash = (
  name: string,
  command: string,
  content: string,
  files: Record<string, string> = {},
  later?: string
): CorpusCase => ({
  name,
  tool: 'Bash',
  args: { command },
  content,
  files,
  ...(later !== undefined ? { later } : {}),
})

/** A file a probe showed whole, as a search over it shows it: through the
 *  Grep tool (numbered, one file and many) and through `grep -rn`. */
function viaSearch(name: string, path: string, text: string, later: string): CorpusCase[] {
  const files = { [path]: text }
  const body = lines(text)
  return [
    grep(`${name} (Grep -n)`, numbered(path, text), files, { '-C': 20 }, later),
    grep(
      `${name} (Grep, one file)`,
      body.map((l, i) => `${i + 1}:${l}`).join('\n'),
      files,
      { path, '-C': 20 },
      later
    ),
    grep(
      `${name} (Grep, no -n)`,
      body.map((l) => `${path}:${l}`).join('\n'),
      files,
      { '-n': false, '-C': 20 },
      later
    ),
    bash(
      `${name} (grep -rn)`,
      `grep -rn '' ${path.split('/')[0]}`,
      numbered(path, text),
      files,
      later
    ),
  ]
}

const pathOf = (c: { path?: string; command?: string }, i: number, fallback: string) =>
  (c.path?.replace(/^\/r\//, '') ?? c.command?.replace(/^cat\s+/, '') ?? fallback).replace(
    /^(?:aws|gcloud|terraform)\b.*$/,
    `out/result-${i}.json`
  )

const probes: CorpusCase[] = []
for (const [set, cases] of Object.entries(RAW)) {
  cases.forEach((c, i) => {
    const name = `${set}[${i}]`
    if (set.startsWith('grep_')) {
      const content = c as string
      probes.push(grep(name, content))
      // The same with every file it names on disk.
      const named = new Set<string>()
      for (const l of content.split('\n')) {
        const m = /^([^:]+?\.[A-Za-z]+|[^:]*secrets\/[\w.]+):/.exec(l)
        if (m && !m[1]!.startsWith('/')) named.add(m[1]!)
      }
      if (named.size)
        probes.push(
          grep(
            `${name} (files on disk)`,
            content,
            Object.fromEntries([...named].map((p) => [p, 'x\n']))
          )
        )
    } else if (set.startsWith('pair_')) {
      const [content, later] = c as [string, string]
      const local = content.replace(/\/r\//g, '${ROOT}/')
      const files: Record<string, string> = {}
      for (const l of local.split('\n')) {
        const m = /^\$\{ROOT\}\/([^:]+):/.exec(l)
        if (m) files[m[1]!] = 'x\n'
      }
      probes.push(grep(name, local, files, {}, later))
      probes.push(bash(`${name} (Bash)`, 'grep -rn secret .', local, files, later))
    } else if (set.startsWith('text_')) {
      const [text, later] = c as [string, string]
      const path = text.trimStart().startsWith('{')
        ? `config/probe-${i}.json`
        : `config/probe-${i}.yaml`
      probes.push(...viaSearch(name, path, text, later))
    } else {
      const f = c as { path?: string; command?: string; a: string; b: string }
      probes.push(...viaSearch(name, pathOf(f, i, `config/probe-${i}.yaml`), f.a, f.b))
    }
  })
}

// ── the live Grep tool's formats (T001) ─────────────────────────────────────
const T001_FILES = {
  'deploy/k8s.yaml':
    'env:\n  - name: DB_PASSWORD\n    value: Qx7mKpLzRvNwTyB\n  - name: MODE\n    value: prod\n',
  'secrets/db_password': 'hunter2hunter2\n',
  'releases/2026-11-05/app-1-2.yaml': 'app:\npassword: Xk9mQ2vL7ZpQwR\n',
  'my app/c.yaml': 'password: Pz6vT1yHq8LmNc\n',
  'grep-log.jsonl': '{}\n',
}
const formats: CorpusCase[] = Object.entries(GREP_FORMATS).flatMap(([name, f]) => [
  grep(
    `T001 ${name}`,
    f.result.content,
    T001_FILES,
    f.input,
    'Qx7mKpLzRvNwTyB hunter2hunter2 Xk9mQ2vL7ZpQwR'
  ),
  grep(`T001 ${name} (no files)`, f.result.content, {}, f.input),
])

// ── split pairs (SC-001: at least 50) ───────────────────────────────────────
const split: CorpusCase[] = []
for (let i = 0; i < 18; i++) {
  const v = STRONG(i)
  const k8s = `deploy/app-${i}.yaml`
  const yaml = `config/db-${i}.yml`
  const xml = `conf/server-${i}.xml`
  const files = {
    [k8s]: `env:\n  - name: DB_PASSWORD\n    value: ${v}\n`,
    [yaml]: `db:\n  password:\n    ${v}\n`,
    [xml]: `<db>\n  <password>\n    ${v}\n  </password>\n</db>\n`,
  }
  const shapes: [string, string[]][] = [
    [k8s, ['  - name: DB_PASSWORD', `    value: ${v}`]],
    [yaml, ['  password:', `    ${v}`]],
    [xml, ['  <password>', `    ${v}`, '  </password>']],
  ]
  const [path, body] = shapes[i % 3]!
  split.push(
    grep(
      `split ${i}: -n, -A`,
      body.map((l, j) => `${path}${j ? '-' : ':'}${j + 2}${j ? '-' : ':'}${l}`).join('\n'),
      files,
      { '-A': 2 },
      `connecting with ${v}`
    ),
    grep(
      `split ${i}: no -n, -A`,
      body.map((l, j) => `${path}${j ? '-' : ':'}${l}`).join('\n'),
      files,
      { '-A': 2, '-n': false },
      `connecting with ${v}`
    ),
    grep(
      `split ${i}: one file`,
      body.map((l, j) => `${j + 2}${j ? '-' : ':'}${l}`).join('\n'),
      files,
      { '-A': 2, path },
      `connecting with ${v}`
    ),
    bash(
      `split ${i}: rg -n -A2`,
      `rg -n -A2 password ${path.split('/')[0]}`,
      body.map((l, j) => `${path}${j ? '-' : ':'}${j + 2}${j ? '-' : ':'}${l}`).join('\n'),
      files,
      `connecting with ${v}`
    )
  )
}
// Two files interleaved: each value pairs with its own file's key only.
split.push(
  grep(
    'interleaved k8s files',
    [
      'a/k8s.yaml:2:  - name: DB_PASSWORD',
      'b/k8s.yaml:2:  - name: MODE',
      'a/k8s.yaml-3-    value: Wb4nR8tLq2XzKm',
      'b/k8s.yaml-3-    value: Pz6vT1yHq8LmNc',
    ].join('\n'),
    { 'a/k8s.yaml': 'x\n', 'b/k8s.yaml': 'x\n' },
    { '-A': 1 },
    'Wb4nR8tLq2XzKm Pz6vT1yHq8LmNc'
  ),
  grep(
    'k8s pair split by --',
    'a/k8s.yaml:2:  - name: DB_PASSWORD\n--\na/k8s.yaml-3-    value: Wb4nR8tLq2XzKm',
    { 'a/k8s.yaml': 'x\n' },
    { '-A': 1 },
    'Wb4nR8tLq2XzKm'
  ),
  grep(
    'k8s pair with a gap in numbering',
    'a/k8s.yaml:2:  - name: DB_PASSWORD\na/k8s.yaml-9-    value: Wb4nR8tLq2XzKm',
    { 'a/k8s.yaml': 'x\n' },
    { '-A': 1 },
    'Wb4nR8tLq2XzKm'
  )
)

// ── learning and its limits ─────────────────────────────────────────────────
const learning: CorpusCase[] = [
  grep(
    'a config line remembered',
    'config/app.yaml:12:password: Xk9mQ2vL7ZpQwR',
    { 'config/app.yaml': 'x\n' },
    {},
    'Xk9mQ2vL7ZpQwR'
  ),
  grep(
    'a code file: unquoted not remembered, quoted remembered',
    'src/app.py:4:    self.secret_key = rotateKeyV2Xq9\nsrc/app.py:5:    session_token = "Xk9mQ2vL7ZpQwR"',
    { 'src/app.py': 'x\n' },
    {},
    'rotateKeyV2Xq9 Xk9mQ2vL7ZpQwR'
  ),
  grep(
    'a weak value masked where it stands only',
    'config/app.yaml:3:password: admin\nREADME.md:9:log in as admin',
    { 'config/app.yaml': 'x\n', 'README.md': 'x\n' },
    {},
    'admin'
  ),
  grep(
    'decision #5: a word and a year',
    'config/app.yaml:3:password: sunshine2026',
    { 'config/app.yaml': 'x\n' },
    {},
    'the sunshine2026 campaign'
  ),
  grep(
    'references and encrypted values are not remembered',
    [
      'config/app.yaml:1:password: ${DB_PASSWORD}',
      'config/app.yaml:2:api_token: ENC(Xq9mK2pLzRvNw7Ab)',
      'config/app.yaml:3:secret_key: arn:aws:kms:us-east-1:123456789012:key/abcd',
      'config/app.yaml:4:db_password: PROD_DB_PASSWORD_V2',
      'config/app.yaml:5:passwordSecret: argocd-repo-creds-x7k',
    ].join('\n'),
    { 'config/app.yaml': 'x\n' },
    {},
    'ENC(Xq9mK2pLzRvNw7Ab) PROD_DB_PASSWORD_V2 argocd-repo-creds-x7k'
  ),
]

// ── files named for their key ───────────────────────────────────────────────
const named: CorpusCase[] = [
  ['secrets/db_password', 'hunter2hunter2'],
  ['secrets/db_password', 'Xq9mK2pLzRvNw7'],
  ['secrets/api_token.txt', 'Tr0ub4dor&3xyz'],
  ['deploy/secrets/postgres_password', 'Xq9mK2pLzRvNw7'],
  ['secrets/db.yaml', 'password: Xq9mK2pLzRvNw7'],
].flatMap(([path, value]) => [
  grep(
    `named ${path}: -n`,
    `${path}:1:${value}\nsrc/a.ts:1:x`,
    { [path!]: `${value}\n`, 'src/a.ts': 'x\n' },
    {},
    value
  ),
  grep(
    `named ${path}: no -n`,
    `${path}:${value}\nsrc/a.ts:x`,
    { [path!]: `${value}\n`, 'src/a.ts': 'x\n' },
    { '-n': false },
    value
  ),
  grep(`named ${path}: one file`, `1:${value}`, { [path!]: `${value}\n` }, { path }, value),
  bash(
    `named ${path}: rg`,
    `rg -n ${value.slice(0, 4)} ${path}`,
    `1:${value}`,
    { [path!]: `${value}\n` },
    value
  ),
  bash(
    `named ${path}: grep -rn`,
    `grep -rn x .`,
    `./${path}:1:${value}`,
    { [path!]: `${value}\n` },
    value
  ),
])
named.push(
  grep(
    'named /run/secrets/api_token',
    '/run/secrets/api_token:1:Tr0ub4dor&3xyz\nsrc/a.ts:1:x',
    { 'src/a.ts': 'x\n' },
    {},
    'Tr0ub4dor&3xyz'
  )
)

// ── paths and prefixes that split more than one way ─────────────────────────
const PG = 'localhost:5432:*:postgres:Xq9mK2pLzRvNw7'
const paths: CorpusCase[] = [
  grep(
    'pgpass -n',
    `deploy/db.pgpass:1:${PG}`,
    { 'deploy/db.pgpass': `${PG}\n` },
    {},
    'Xq9mK2pLzRvNw7'
  ),
  grep(
    'pgpass no -n',
    `deploy/db.pgpass:${PG}`,
    { 'deploy/db.pgpass': `${PG}\n` },
    { '-n': false },
    'Xq9mK2pLzRvNw7'
  ),
  grep(
    'pgpass one file',
    `1:${PG}`,
    { '.pgpass': `${PG}\n` },
    { path: '.pgpass' },
    'Xq9mK2pLzRvNw7'
  ),
  grep('pgpass one file, no -n', PG, { '.pgpass': `${PG}\n` }, { path: '.pgpass', '-n': false }),
  bash('pgpass rg', 'rg postgres .pgpass', PG, { '.pgpass': `${PG}\n` }),
  bash('pgpass grep -rn', 'grep -rn postgres deploy', `deploy/db.pgpass:1:${PG}`, {
    'deploy/db.pgpass': `${PG}\n`,
  }),
  grep(
    'a dated directory with dash-digit runs',
    'releases/2026-11-05/app-1-2.yaml:2:password: Xk9mQ2vL7ZpQwR\nreleases/2026-11-05/app-1-2.yaml-3-  user: deploy',
    { 'releases/2026-11-05/app-1-2.yaml': 'x\n' },
    { '-A': 1 },
    'Xk9mQ2vL7ZpQwR'
  ),
  grep(
    'a dated directory where a shorter prefix is a file too',
    'releases/2026-11-05/app-1-2.yaml:2:password: Xk9mQ2vL7ZpQwR',
    { 'releases/2026-11-05/app-1-2.yaml': 'x\n', 'releases/2026-11-05/app': 'x\n' },
    {},
    'Xk9mQ2vL7ZpQwR'
  ),
  grep(
    'two candidates that are both files',
    'notes:1:2:password: Xk9mQ2vL7ZpQwR',
    { notes: 'x\n', 'notes:1': 'x\n' },
    {},
    'Xk9mQ2vL7ZpQwR'
  ),
  grep(
    'a path with a space',
    'my app/c.yaml:1:password: Pz6vT1yHq8LmNc',
    { 'my app/c.yaml': 'x\n' },
    {},
    'Pz6vT1yHq8LmNc'
  ),
  grep(
    'an absolute path',
    '${ROOT}/config/app.yaml:1:password: Pz6vT1yHq8LmNc',
    { 'config/app.yaml': 'x\n' },
    {},
    'Pz6vT1yHq8LmNc'
  ),
  grep(
    'a Windows path',
    'C:\\work\\project\\config\\app.yaml:1:password: Pz6vT1yHq8LmNc\nC:\\work\\project\\config\\app.yaml-2-  user: x',
    {},
    { '-A': 1 }
  ),
  grep(
    'a value holding :12:',
    'config/app.yaml:3:  password: Qx7m:12:KpL9zRvNwTyB',
    { 'config/app.yaml': 'x\n' },
    {},
    'KpL9zRvNwTyB'
  ),
  grep(
    'a value holding -12-',
    'config/app.yaml:3:  password: Qx7m-12-KpL9zRvNwTyB',
    { 'config/app.yaml': 'x\n' },
    {}
  ),
  grep(
    'a result cut short: context lines only',
    'deploy/k8s.yaml-3-    value: Qx7mKpLzRvNwTyB\ndeploy/k8s.yaml-4-  - name: MODE',
    { 'deploy/k8s.yaml': 'x\n' },
    { '-B': 1 }
  ),
  grep(
    'the same file in two groups',
    'deploy/k8s.yaml:2:  - name: DB_PASSWORD\ndeploy/k8s.yaml-3-    value: Qx7mKpLzRvNwTyB\n--\ndeploy/k8s.yaml:8:  - name: API_TOKEN\ndeploy/k8s.yaml-9-    value: Wb4nR8tLq2XzKm',
    { 'deploy/k8s.yaml': 'x\n' },
    { '-A': 1 },
    'Qx7mKpLzRvNwTyB Wb4nR8tLq2XzKm'
  ),
  grep('a binary-file notice', 'Binary file dist/app.bin matches\nconfig/app.yaml:1:token: x', {
    'config/app.yaml': 'x\n',
  }),
  grep(
    'a context line of a file not on disk',
    'gone/app.yaml:2:  - name: DB_PASSWORD\ngone/app.yaml-3-    value: Qx7mKpLzRvNwTyB',
    {},
    { '-A': 1 }
  ),
  grep(
    'a known source file, keywords and names',
    'src/ledger.ts:3:    const settledTotal = entries.reduce((a, b) => a + b, 0)\nsrc/ledger.ts:4:    return settledTotal',
    { 'src/ledger.ts': 'x\n' }
  ),
]

// ── shell output that is not search output ──────────────────────────────────
const LOG = '12:30:01 INFO password=Xk9mQ2vL7ZpQwR accepted\n12:30:02 db-1-2 ready\n'
const shell: CorpusCase[] = [
  bash('a log with timestamps', 'cat app.log', LOG, { 'app.log': LOG }),
  bash('a log through tail', 'tail -n 2 app.log', LOG, { 'app.log': LOG }),
  bash('ls -l', 'ls -l', '-rw-r--r--  1 u  staff  12 Nov  6 12:30 config.yaml\n', {
    'config.yaml': 'x\n',
  }),
  bash('rg -l', 'rg -l password', 'config/app.yaml\n', { 'config/app.yaml': 'x\n' }),
  bash('rg -c', 'rg -c password', 'config/app.yaml:1\n', { 'config/app.yaml': 'x\n' }),
  bash(
    'rg --json',
    'rg --json password',
    '{"type":"match","data":{"path":{"text":"config/app.yaml"}}}\n',
    { 'config/app.yaml': 'x\n' }
  ),
  bash('rg into sort', 'rg -n password | sort', 'config/app.yaml:1:password: Xk9mQ2vL7ZpQwR\n', {
    'config/app.yaml': 'x\n',
  }),
  bash(
    'a compound command',
    'cd config && rg -n password',
    'app.yaml:1:password: Xk9mQ2vL7ZpQwR\n',
    { 'config/app.yaml': 'x\n' }
  ),
  bash(
    'rg into head',
    'rg -n -A1 DB_PASSWORD deploy | head -n 20',
    'deploy/k8s.yaml:2:  - name: DB_PASSWORD\ndeploy/k8s.yaml-3-    value: Qx7mKpLzRvNwTyB\n',
    { 'deploy/k8s.yaml': 'x\n' },
    'Qx7mKpLzRvNwTyB'
  ),
  bash(
    'rg piped, no numbers',
    'rg -A1 DB_PASSWORD deploy',
    'deploy/k8s.yaml:  - name: DB_PASSWORD\ndeploy/k8s.yaml-    value: Qx7mKpLzRvNwTyB\n',
    { 'deploy/k8s.yaml': 'x\n' },
    'Qx7mKpLzRvNwTyB'
  ),
  bash(
    'grep -n on one file',
    'grep -n -A1 DB_PASSWORD deploy/k8s.yaml',
    '2:  - name: DB_PASSWORD\n3-    value: Qx7mKpLzRvNwTyB\n',
    { 'deploy/k8s.yaml': 'x\n' },
    'Qx7mKpLzRvNwTyB'
  ),
]

/** A 1 MB result: 20,000 short lines and one line of 500 KB full of
 *  dash-digit-dash runs (e72 timed out on it). */
export function bigResult(tool: 'Grep' | 'Bash'): CorpusCase {
  const short = Array.from({ length: 20_000 }, (_, i) => `src/a.ts:${i + 1}:const x${i} = ${i}`)
  const long = `dist/app.min.js:1:${'-1-2'.repeat(125_000)}`
  const content = [...short.slice(0, 10_000), long, ...short.slice(10_000)].join('\n')
  const files = { 'src/a.ts': 'x\n', 'dist/app.min.js': 'x\n' }
  return tool === 'Grep'
    ? grep('1 MB result', content, files, { pattern: 'x' })
    : bash('1 MB result (rg -n)', 'rg -n x src dist', content, files)
}

export const CORPUS: CorpusCase[] = [
  ...formats,
  ...split,
  ...learning,
  ...named,
  ...paths,
  ...shell,
  ...probes,
]
