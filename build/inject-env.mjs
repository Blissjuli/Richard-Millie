/**
 * inject-env.mjs — build-time env injection for the static RSVP endpoint.
 *
 * Replaces the __RSVP_ENDPOINT__ placeholder in index.html with the value of
 * RSVP_ENDPOINT (from the environment, or from a local .env file for testing)
 * so the real Formspree ID never appears in committed source.
 *
 * Usage:
 *   node build/inject-env.mjs            # inject
 *   node build/inject-env.mjs --check    # verify without writing (CI)
 *
 * Behaviour when RSVP_ENDPOINT is missing: the placeholder is left in place
 * and the build exits non-zero, so a misconfigured deploy fails loudly
 * instead of shipping a form that posts nowhere.
 */
import { readFile, writeFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const TARGET = resolve(ROOT, "index.html");
const PLACEHOLDER = "__RSVP_ENDPOINT__";
const KEY = "RSVP_ENDPOINT";

/** Minimal .env parser — no dependency needed for a single KEY=value pair. */
async function readDotEnv() {
  try {
    await access(resolve(ROOT, ".env"));
  } catch {
    return {};
  }
  const raw = await readFile(resolve(ROOT, ".env"), "utf8");
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();
    // strip matching surrounding quotes
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

async function main() {
  const checkOnly = process.argv.includes("--check");

  // Real environment (Vercel, CI, local shell) wins over .env
  const dotenv = await readDotEnv();
  const endpoint = process.env[KEY] || dotenv[KEY] || "";

  const html = await readFile(TARGET, "utf8");
  const occurrences = html.split(PLACEHOLDER).length - 1;
  const alreadyInjected = /rsvpEndpoint:\s*"https:\/\/formspree\.io\/f\/[A-Za-z0-9]+"/.test(html);

  /* Idempotency: building twice must not fail. If the placeholder is gone but
     a valid endpoint is already sitting in the CONFIG, the previous build
     succeeded — report that and exit cleanly. (Vercel can rebuild from a
     cached output directory, so this is not a theoretical case.) */
  if (occurrences === 0) {
    if (alreadyInjected) {
      console.log("✓ No placeholder found, but index.html already has an injected endpoint — nothing to do.");
      return;
    }
    console.error(
      `✗ No ${PLACEHOLDER} placeholder found in index.html.\n` +
        `  Add ${PLACEHOLDER} as the rsvpEndpoint value in the CONFIG block, then re-run.`
    );
    process.exit(1);
  }

  if (!endpoint) {
    console.error(
      `✗ ${KEY} is not set.\n` +
        `  Set it in the Vercel dashboard (Settings → Environment Variables),\n` +
        `  or in a local .env file: ${KEY}=https://formspree.io/f/<your-id>`
    );
    if (checkOnly) process.exit(1);
    // Leave the placeholder untouched — a clear marker beats a broken form.
    process.exit(1);
  }

  if (!/^https:\/\/formspree\.io\/f\/[A-Za-z0-9]+$/.test(endpoint)) {
    console.error(
      `✗ ${KEY} does not look like a Formspree endpoint:\n    ${endpoint}\n` +
        `  Expected https://formspree.io/f/<id>`
    );
    process.exit(1);
  }

  if (checkOnly) {
    console.log(`✓ ${occurrences} placeholder(s) present, ${KEY} looks valid.`);
    return;
  }

  await writeFile(TARGET, html.split(PLACEHOLDER).join(endpoint), "utf8");
  console.log(`✓ Injected ${KEY} into ${occurrences} placeholder(s) in index.html`);
  // Log only the host, never the full ID, to keep logs low-value to scrapers.
  console.log(`  target: ${new URL(endpoint).origin}/f/…`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
