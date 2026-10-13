// Stages the SDK for npm in `.publish/<name>/`: its built `dist`, with the
// private workspace packages it uses copied into `dist/vendor/` and every
// import of them rewritten to a relative path, so the package installs alone.
// Source maps are left out. Run after `pnpm build`:
//
//   node scripts/stage-sdk.ts && cd .publish/<name> && npm publish --access public

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(join(root, 'sdk.publish.json'), 'utf8')) as {
  /** The workspace package published, its directory, and the npm name and version. */
  readonly source: string;
  readonly name: string;
  readonly version: string;
  readonly keywords: readonly string[];
  /** Workspace packages copied in, by package name: their directories. */
  readonly vendor: Readonly<Record<string, string>>;
};

const sdk = join(root, config.source);
const manifest = JSON.parse(readFileSync(join(sdk, 'package.json'), 'utf8'));
const stage = join(root, '.publish', config.name);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

const dist = join(stage, 'dist');
copyDist(join(sdk, 'dist'), dist);
const entries: Record<string, string> = {};
for (const [name, dir] of Object.entries(config.vendor)) {
  const target = join(dist, 'vendor', name.split('/').pop()!);
  copyDist(join(root, dir, 'dist'), target);
  entries[name] = join(target, 'index.js');
}

for (const file of files(dist)) {
  if (!file.endsWith('.js') && !file.endsWith('.d.ts')) continue;
  const text = readFileSync(file, 'utf8')
    .replace(/^\/\/# sourceMappingURL=.*$/m, '')
    .replace(
      /(from\s+|import\s*\()(['"])([^'"]+)\2/g,
      (whole, lead: string, quote: string, spec: string) => {
        if (spec in entries) {
          let path = relative(dirname(file), entries[spec]!).split(sep).join('/');
          if (!path.startsWith('.')) path = `./${path}`;
          return `${lead}${quote}${path}${quote}`;
        }
        if (spec.startsWith('@acentric-')) throw new Error(`${file}: ${spec} is not vendored.`);
        // Declarations keep `.ts` in relative imports; point them at the emitted files.
        if (spec.startsWith('.') && spec.endsWith('.ts')) {
          return `${lead}${quote}${spec.slice(0, -3)}.js${quote}`;
        }
        return whole;
      },
    );
  writeFileSync(file, text);
}

const exports = Object.fromEntries(
  Object.entries(manifest.exports as Record<string, { types: string; default: string }>).map(
    ([path, entry]) => [path, { types: entry.types, default: entry.default }],
  ),
);
writeFileSync(
  join(stage, 'package.json'),
  JSON.stringify(
    {
      name: config.name,
      version: config.version,
      description: manifest.description,
      keywords: config.keywords,
      type: 'module',
      sideEffects: false,
      exports,
      files: ['dist'],
    },
    null,
    2,
  ) + '\n',
);
cpSync(join(sdk, 'README.md'), join(stage, 'README.md'));
console.log(`Staged ${config.name}@${config.version} in ${relative(root, stage)}`);

function copyDist(from: string, to: string): void {
  if (!existsSync(from)) throw new Error(`${from} is missing; run pnpm build first.`);
  cpSync(from, to, { recursive: true, filter: (path) => !path.endsWith('.map') });
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}
