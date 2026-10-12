// Gets a module ready for a release: checks the tag against module.json, fills in this repository's links, checks that
// every file the manifest loads is present, and writes this version's changelog section as the release notes.
// Usage: node .github/scripts/prepare-release.mjs v1.2.3 owner/repository
import {existsSync, readFileSync, writeFileSync} from "node:fs";

const [tag, repository] = process.argv.slice(2);
const fail = message => {
  console.error(`::error::${message}`);
  process.exit(1);
};
if ( !tag || !repository?.includes("/") ) fail("Usage: prepare-release.mjs <tag> <owner/repository>");

const manifest = JSON.parse(readFileSync("module.json", "utf8"));
const version = tag.replace(/^v/, "");
if ( manifest.version !== version ) fail(`The tag ${tag} doesn't match the version in module.json (${manifest.version}).`);

const owner = repository.split("/")[0];
const home = `https://github.com/${repository}`;
Object.assign(manifest, {
  url: home,
  manifest: `${home}/releases/latest/download/module.json`,
  download: `${home}/releases/download/${tag}/module.zip`,
  bugs: `${home}/issues`,
  readme: `${home}/blob/${tag}/README.md`,
  changelog: `${home}/blob/${tag}/CHANGELOG.md`
});

// The family's other modules live in repositories named after their ids, under the same owner: Foundry installs a
// required one from its manifest when it isn't installed yet
for ( const list of Object.values(manifest.relationships ?? {}) ) {
  for ( const rel of Array.isArray(list) ? list : [] ) {
    if ( rel.id?.startsWith("kostis-") ) rel.manifest = `https://github.com/${owner}/${rel.id}/releases/latest/download/module.json`;
  }
}

// Everything the manifest loads must be in the package
const files = [...(manifest.esmodules ?? []), ...(manifest.scripts ?? []), ...(manifest.styles ?? []),
  ...(manifest.languages ?? []).map(l => l.path), ...(manifest.packs ?? []).map(p => p.path)];
const missing = files.filter(f => f && !existsSync(f));
if ( missing.length ) fail(`module.json lists files that don't exist: ${missing.join(", ")}`);
writeFileSync("module.json", `${JSON.stringify(manifest, null, 2)}\n`);

// The release notes: this version's section of the changelog (from "## 1.2.3" up to the next "## ")
let notes = "";
if ( existsSync("CHANGELOG.md") ) {
  const lines = readFileSync("CHANGELOG.md", "utf8").split(/\r?\n/);
  const heading = new RegExp(`^##\\s+\\[?v?${version.replaceAll(".", "\\.")}\\]?(\\s|$)`);
  const start = lines.findIndex(l => heading.test(l));
  if ( start >= 0 ) {
    const end = lines.findIndex((l, i) => (i > start) && /^##\s/.test(l));
    notes = lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
  }
}
if ( !notes ) fail(`CHANGELOG.md has no section for ${version} ("## ${version}").`);
writeFileSync("release-notes.md", `${notes}\n\n**Manifest URL:** ${manifest.manifest}\n`);
console.log(`Prepared ${manifest.title} ${version}`);
