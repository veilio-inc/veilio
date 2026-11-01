// Security review, round 4 (C): a generated corpus of credential syntaxes,
// one template per format, each filled with every VALUE. Shared by
// credential-corpus.test.ts (the CI gate) and scripts/value-differential.mts
// (the counts of record).

/** A strong value a rule finds, a dictionary word, and a weak password. */
export const VALUES = ['Xk9mQ2vL8pR4wZ7t', 'sunshine', 'Summer2024!'] as const

export interface SyntaxCase {
  format: string
  path: string
  text: (value: string) => string
}

export const SYNTAXES: SyntaxCase[] = [
  { format: 'dotenv', path: '.env', text: (v) => `DB_PASSWORD=${v}\n` },
  { format: 'dotenv export', path: '.env', text: (v) => `export API_TOKEN=${v}\n` },
  { format: 'dotenv quoted', path: '.env.local', text: (v) => `SECRET_KEY="${v}"\n` },
  { format: 'yaml', path: 'app.yml', text: (v) => `password: ${v}\n` },
  { format: 'yaml nested', path: 'app.yaml', text: (v) => `db:\n  password: ${v}\n` },
  { format: 'yaml quoted', path: 'app.yml', text: (v) => `api_key: "${v}"\n` },
  { format: 'yaml block', path: 'app.yml', text: (v) => `password:\n  ${v}\n` },
  { format: 'yaml flag list', path: 'k8s.yml', text: (v) => `args: ["--db-password=${v}"]\n` },
  {
    format: 'k8s env',
    path: 'deploy.yaml',
    text: (v) => `env:\n  - name: DB_PASSWORD\n    value: ${v}\n`,
  },
  {
    format: 'docker-compose',
    path: 'docker-compose.yml',
    text: (v) => `services:\n  db:\n    environment:\n      POSTGRES_PASSWORD: ${v}\n`,
  },
  {
    format: 'docker-compose list',
    path: 'compose.yaml',
    text: (v) => `environment:\n  - POSTGRES_PASSWORD=${v}\n`,
  },
  { format: 'json', path: 'config.json', text: (v) => `{"password": "${v}"}\n` },
  { format: 'json nested', path: 'a.json', text: (v) => `{"db": {"auth": {"token": "${v}"}}}\n` },
  { format: 'toml', path: 'app.toml', text: (v) => `[db]\npassword = "${v}"\n` },
  { format: 'toml triple', path: 'app.toml', text: (v) => `password = '''${v}'''\n` },
  { format: 'ini', path: 'app.ini', text: (v) => `[db]\npassword = ${v}\n` },
  { format: 'ini colon', path: 'app.cfg', text: (v) => `[db]\npassword: ${v}\n` },
  { format: 'properties', path: 'app.properties', text: (v) => `db.password=${v}\n` },
  { format: 'properties space', path: 'app.properties', text: (v) => `password ${v}\n` },
  {
    format: 'properties continuation',
    path: 'app.properties',
    text: (v) => `db.password = \\\n    ${v}\n`,
  },
  { format: 'xml element', path: 'app.xml', text: (v) => `<password>${v}</password>\n` },
  {
    format: 'xml cdata',
    path: 'app.xml',
    text: (v) => `<password><![CDATA[${v}]]></password>\n`,
  },
  {
    format: 'xml appSettings',
    path: 'Web.config',
    text: (v) => `<add key="DbPassword" value="${v}"/>\n`,
  },
  {
    format: 'maven property',
    path: 'pom.xml',
    text: (v) => `<property name="password" value="${v}"/>\n`,
  },
  { format: 'shell export', path: 'run.sh', text: (v) => `export DB_PASSWORD=${v}\n` },
  { format: 'shell prefix', path: 'run.sh', text: (v) => `DB_PASSWORD=${v} ./run\n` },
  { format: 'shell flag', path: 'run.sh', text: (v) => `app --db-password=${v}\n` },
  { format: 'shell flag spaced', path: 'run.sh', text: (v) => `mysql -u root --password ${v}\n` },
  { format: 'makefile', path: 'Makefile', text: (v) => `PASSWORD := ${v}\n` },
  { format: 'dockerfile env', path: 'Dockerfile', text: (v) => `ENV DB_PASSWORD ${v}\n` },
  { format: 'dockerfile env =', path: 'Dockerfile', text: (v) => `ENV DB_PASSWORD=${v}\n` },
  { format: 'hcl', path: 'main.tf', text: (v) => `db_password = "${v}"\n` },
  { format: 'tfvars', path: 'prod.tfvars', text: (v) => `db_password = ${v}\n` },
  {
    format: 'netrc',
    path: '.netrc',
    text: (v) => `machine h login u password ${v}\n`,
  },
  { format: 'npmrc', path: '.npmrc', text: (v) => `//registry.npmjs.org/:_authToken=${v}\n` },
  { format: 'pgpass', path: '.pgpass', text: (v) => `localhost:5432:app:admin:${v}\n` },
  { format: 'bat', path: 'run.bat', text: (v) => `set DB_PASSWORD=${v}\r\n` },
  { format: 'markdown', path: 'README.md', text: (v) => `# Setup\n\nDB_PASSWORD=${v}\n` },
  { format: 'text', path: 'notes.txt', text: (v) => `password: ${v}\n` },
  { format: 'python', path: 'settings.py', text: (v) => `password = "${v}"\n` },
  {
    format: 'python dict',
    path: 'settings.py',
    text: (v) => `DATABASES = {"default": {"PASSWORD": "${v}"}}\n`,
  },
  { format: 'javascript', path: 'db.js', text: (v) => `const password = "${v}"\n` },
  {
    format: 'typescript object',
    path: 'db.ts',
    text: (v) => `export const db = { apiKey: "${v}" }\n`,
  },
  { format: 'java', path: 'Db.java', text: (v) => `String password = "${v}";\n` },
  { format: 'java setter', path: 'Db.java', text: (v) => `ds.setPassword("${v}");\n` },
  { format: 'kotlin', path: 'Db.kt', text: (v) => `val password = "${v}"\n` },
  {
    format: 'csharp property',
    path: 'Db.cs',
    text: (v) => `public string Password { get; set; } = "${v}";\n`,
  },
  { format: 'go', path: 'db.go', text: (v) => `password := "${v}"\n` },
  { format: 'ruby', path: 'db.rb', text: (v) => `password = '${v}'\n` },
  { format: 'php', path: 'config.php', text: (v) => `define('DB_PASSWORD', '${v}');\n` },
  { format: 'rust', path: 'main.rs', text: (v) => `let password = "${v}";\n` },
  {
    format: 'sql connection string',
    path: 'Db.cs',
    text: (v) => `var c = "Server=x;Database=y;User Id=u;Password=${v};";\n`,
  },
  { format: 'url userinfo', path: '.env', text: (v) => `DATABASE_URL=postgres://u:${v}@db/app\n` },
  { format: 'camel segment', path: 'app.yml', text: (v) => `dbPw: ${v}\n` },
  { format: 'run-together segment', path: '.env', text: (v) => `DBPW=${v}\n` },
  { format: 'upper segment', path: 'app.ini', text: (v) => `userPW = ${v}\n` },
  { format: 'jwt secret', path: '.env', text: (v) => `JWT_SECRET=${v}\n` },
  { format: 'mnemonic', path: 'app.yml', text: (v) => `wallet_mnemonic: ${v}\n` },
]
