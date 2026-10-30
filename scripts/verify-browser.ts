import { chromium, type Page } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createServer } from "node:net";
import assert from "node:assert/strict";
const scratch = await mkdtemp(resolve(tmpdir(), "everleaf-browser-")),
  out = resolve(process.env.BROWSER_EVIDENCE || "../../work/everleaf-browser");
await mkdir(out, { recursive: true });
const port = await new Promise<number>((done) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const a = server.address();
    assert(a && typeof a === "object");
    server.close(() => done(a.port));
  });
});
const origin = `http://127.0.0.1:${port}`,
  errors: string[] = [],
  checks: string[] = [];
let child: ReturnType<typeof spawn> | null = null,
  logs = "";
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
async function ready() {
  await new Promise<void>((done, reject) => {
    child = spawn(
      process.execPath,
      ["--experimental-strip-types", "src/server.ts"],
      {
        env: {
          ...process.env,
          PORT: String(port),
          HOST: "127.0.0.1",
          APP_ORIGIN: origin,
          DATA_DIR: scratch,
          NODE_ENV: "development",
          RESEND_API_KEY: "",
          EMAIL_FROM: "",
          MODERATOR_EMAILS: "moderator@example.test",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const timer = setTimeout(
      () => reject(Error(logs || "Startup timed out")),
      15000,
    );
    child.stdout!.on("data", (c) => {
      logs += c;
      if (logs.includes("Everleaf:")) {
        clearTimeout(timer);
        done();
      }
    });
    child.stderr!.on("data", (c) => (logs += c));
    child.once("exit", (code) => {
      if (code) {
        clearTimeout(timer);
        reject(Error(logs));
      }
    });
  });
}
async function context() {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => void d.accept());
  return page;
}
async function login(
  page: Page,
  address: string,
  name: string,
  path = "/#/home",
) {
  await page.goto(origin + "/#/login?next=" + encodeURIComponent(path));
  await page.locator("#login-form").waitFor();
  await page.getByLabel("Your name", { exact: true }).fill(name);
  await page.getByLabel("Email", { exact: true }).fill(address);
  await page
    .getByRole("button", { name: "Send sign-in link", exact: true })
    .click();
  await page.getByRole("link", { name: "Open sign-in link" }).click();
  await page.locator("#confirm-login").click();
  await page.waitForURL((url) => url.hash === path.slice(1));
  await page.locator(".site").waitFor();
  checks.push("browser sign-in: " + name);
}
async function shot(page: Page, name: string) {
  await page.locator(".site").waitFor();
  await page.waitForFunction(
    () => !document.getElementById("notice")?.textContent,
  );
  await page.screenshot({
    path: resolve(out, name + ".png"),
    fullPage: true,
    animations: "disabled",
  });
  const overflow = await page.evaluate(() => ({
    actual: document.documentElement.scrollWidth,
    viewport: innerWidth,
  }));
  assert(
    overflow.actual <= overflow.viewport + 1,
    `${name} overflows: ${JSON.stringify(overflow)}`,
  );
  const broken = await page.locator("img").evaluateAll((images) =>
    images
      .map((i) => i as HTMLImageElement)
      .filter((i) => !i.complete || !i.naturalWidth)
      .map((i) => i.src),
  );
  assert.deepEqual(broken, [], name + " has broken images");
}
try {
  await ready();
  const owner = await context();
  await login(owner, "owner@example.test", "Jamie");
  await owner
    .locator("header")
    .getByRole("link", { name: "Create a memorial", exact: true })
    .click();
  await owner.getByLabel("Their name").fill("Biscuit");
  await owner.getByLabel("Born (year or date)").fill("2011");
  await owner.getByLabel("Passed (year or date)").fill("2009");
  await owner
    .getByLabel("A short remembrance")
    .fill("Every muddy walk, kept close.");
  await owner
    .getByRole("button", { name: "Save draft and add photos" })
    .click();
  await owner
    .locator("#form-error")
    .filter({ hasText: "cannot be before" })
    .waitFor();
  assert.equal(await owner.getByLabel("Their name").inputValue(), "Biscuit");
  await owner.getByLabel("Passed (year or date)").fill("2025");
  await owner
    .getByRole("button", { name: "Save draft and add photos" })
    .click();
  await owner.waitForURL(/\/photos$/);
  await owner
    .getByLabel("Add or replace portrait")
    .setInputFiles(resolve("public/assets/img/A0.jpg"));
  await owner.locator("#crop-canvas").waitFor();
  await owner
    .getByRole("button", { name: "Save portrait", exact: true })
    .click();
  await owner.locator("img.portrait-large").waitFor();
  checks.push("real file input, browser crop, upload and saved portrait");
  await shot(owner, "01-portrait");
  const mid = owner.url().match(/edit\/([^/]+)\//)![1];
  await owner.getByRole("link", { name: "Continue to sculpture" }).click();
  await owner.locator("input[name=style][value=photo]").check();
  await owner.getByRole("button", { name: "Save and continue" }).click();
  await owner.waitForURL(/\/setting$/);
  await owner.locator("input[name=setting][value=garden]").check();
  await owner.locator("input[name=theme][value=C]").check();
  await owner.getByRole("button", { name: "Save and continue" }).click();
  await owner.waitForURL(/\/personalize$/);
  await owner.locator('[data-kind="Flowers"]').click();
  const object = owner.locator('[data-place="0"]');
  await object.focus();
  await object.press("ArrowRight");
  await owner.getByRole("button", { name: "Save arrangement" }).click();
  await owner
    .getByRole("status")
    .filter({ hasText: "Arrangement saved." })
    .waitFor();
  await owner.getByRole("link", { name: "Preview & publish" }).click();
  await owner.locator("input[name=visibility][value=public]").check();
  await owner
    .getByRole("button", { name: "Publish memorial", exact: true })
    .click();
  await owner.waitForURL(new RegExp("/m/" + mid + "$"));
  await owner.locator(".scene-layout").waitFor();
  await owner.reload();
  await owner.locator(".scene-layout").waitFor();
  const saved = await (
    await owner.request.get(origin + "/api/memorials/" + mid)
  ).json();
  assert.equal(saved.theme, "C");
  assert.equal(saved.setting, "garden");
  assert.equal(saved.style, "photo");
  assert.equal(saved.arrangement[0].x, 51);
  checks.push(
    "creation, independent choices, keyboard placement, publish and reload readback",
  );
  await shot(owner, "02-published-garden");
  await owner.getByRole("link", { name: "Add a memory", exact: true }).click();
  await owner.getByLabel("Title", { exact: true }).fill("Beach mornings");
  await owner
    .getByLabel("Your memory", { exact: true })
    .fill("The waves and the sunny way home.");
  await owner
    .getByLabel("Add a photograph", { exact: true })
    .setInputFiles(resolve("public/assets/img/B1.jpg"));
  await owner.locator(".media-grid input[name=media]").waitFor();
  assert.equal(
    await owner.getByLabel("Your memory", { exact: true }).inputValue(),
    "The waves and the sunny way home.",
  );
  await owner.locator(".media-grid input[name=media]").first().check();
  await owner
    .getByRole("button", { name: "Share memory", exact: true })
    .click();
  await owner
    .locator(".album-entry h2")
    .filter({ hasText: "Beach mornings" })
    .waitFor();
  checks.push(
    "contribution file upload retains draft and saves memory through actual UI",
  );
  await shot(owner, "03-memory");
  await owner.getByRole("link", { name: "Back to their place" }).click();
  await owner
    .getByRole("link", { name: "Light a candle", exact: true })
    .click();
  await owner.getByLabel("Your words (optional)").fill("For our friend.");
  await owner
    .getByRole("button", { name: "Light candle", exact: true })
    .click();
  await owner.getByRole("heading", { name: "Your candle is lit." }).waitFor();
  await owner.reload();
  await owner.getByRole("heading", { name: "Your candle is lit." }).waitFor();
  checks.push("candle lit and retained across browser reload");
  await shot(owner, "04-candle");
  const visitor = await context();
  await visitor.goto(origin + "/#/");
  await visitor.getByRole("link", { name: /Visit Biscuit/ }).click();
  await visitor.locator(".scene-layout").waitFor();
  await visitor
    .getByRole("link", { name: "Open memories", exact: true })
    .click();
  await visitor
    .locator(".album-entry h2")
    .filter({ hasText: "Beach mornings" })
    .waitFor();
  checks.push("anonymous public discovery and actual saved memory visible");
  const alex = await context();
  await login(alex, "alex@example.test", "Alex", "/#/contribute/" + mid);
  await alex.getByLabel("Title", { exact: true }).fill("Sunny <morning>");
  await alex
    .getByLabel("Your memory", { exact: true })
    .fill("A second memory, kept for review.");
  await alex.getByRole("button", { name: "Share memory", exact: true }).click();
  await alex
    .locator(".album-entry h2")
    .filter({ hasText: "Sunny <morning>" })
    .waitFor();
  await visitor.reload();
  await visitor.locator(".album-entry").waitFor();
  assert.equal(
    await visitor.getByText("Sunny <morning>", { exact: true }).count(),
    0,
  );
  await owner.getByRole("link", { name: "Return to their place" }).click();
  await owner.getByRole("link", { name: "Family & review" }).click();
  await owner.getByRole("button", { name: "Approve", exact: true }).click();
  await owner
    .getByText("No memories awaiting review.", { exact: true })
    .waitFor();
  await visitor.reload();
  await visitor
    .getByRole("heading", { name: "Sunny <morning>", exact: true })
    .waitFor();
  checks.push(
    "second account contribution hidden until owner approves; text escaped",
  );
  await shot(owner, "05-family");
  await owner.getByLabel("Invite by email").fill("viewer@example.test");
  await owner.getByLabel("Access", { exact: true }).selectOption("viewer");
  await owner.getByRole("button", { name: "Send invitation" }).click();
  const invitation = owner.locator("#invite-result a");
  await invitation.waitFor();
  const inviteUrl = await invitation.getAttribute("href");
  assert(inviteUrl);
  const viewer = await context();
  await login(
    viewer,
    "viewer@example.test",
    "Viewer",
    new URL(inviteUrl).pathname + new URL(inviteUrl).hash,
  );
  await viewer.getByRole("button", { name: "Accept invitation" }).click();
  await viewer.locator(".scene-layout").waitFor();
  checks.push(
    "invitation created in UI and accepted by its bound email account",
  );
  for (const theme of ["A", "B", "C"])
    for (const setting of ["house", "garden"]) {
      await owner.goto(origin + `/#/edit/${mid}/setting`);
      await owner.locator(`input[name=theme][value=${theme}]`).check();
      await owner.locator(`input[name=setting][value=${setting}]`).check();
      await owner.getByRole("button", { name: "Save and continue" }).click();
      await owner.locator("#edit-scene").waitFor();
      await owner.goto(origin + "/#/m/" + mid);
      await owner.locator(".scene-layout").waitFor();
      await shot(owner, `theme-${theme}-${setting}`);
    }
  checks.push(
    "six approved theme/setting combinations checked through browser saves",
  );
  await owner.setViewportSize({ width: 390, height: 844 });
  for (const [name, path] of [
    ["village", "/"],
    ["visit", "/m/" + mid],
    ["album", "/album/" + mid],
    ["settings", "/settings/" + mid],
    ["details", "/edit/" + mid + "/details"],
    ["themes", "/edit/" + mid + "/setting"],
  ]) {
    await owner.goto(origin + "/#" + path);
    await owner.locator(".site").waitFor();
    await shot(owner, "mobile-" + name);
  }
  checks.push(
    "phone viewport core routes: no horizontal overflow or broken images",
  );
  await owner.setViewportSize({ width: 1440, height: 1000 });
  await owner.goto(origin + "/#/settings/" + mid);
  await owner
    .getByRole("button", { name: "Archive memorial", exact: true })
    .click();
  await owner
    .getByRole("button", { name: "Restore memorial", exact: true })
    .waitFor();
  await visitor.goto(origin + "/#/m/" + mid);
  await visitor
    .getByRole("heading", { name: "This place is not available." })
    .waitFor();
  await owner
    .getByRole("button", { name: "Restore memorial", exact: true })
    .click();
  await owner
    .getByRole("button", { name: "Archive memorial", exact: true })
    .waitFor();
  checks.push("archive hides public visit and restores through owner controls");
  const downloading = owner.waitForEvent("download");
  await owner
    .getByRole("link", { name: "Export photos and memories (.zip)" })
    .click();
  const download = await downloading;
  assert.equal(download.suggestedFilename(), "everleaf-memorial.zip");
  await download.saveAs(resolve(scratch, "browser-export.zip"));
  checks.push("authenticated export produces actual ZIP download");
  await owner.getByLabel("Type Biscuit to confirm").fill("Wrong");
  await owner
    .getByRole("button", { name: "Delete permanently", exact: true })
    .click();
  await owner
    .getByText("Type the pet’s name exactly to confirm deletion.", {
      exact: true,
    })
    .waitFor();
  await owner.getByLabel("Type Biscuit to confirm").fill("Biscuit");
  await owner
    .getByRole("button", { name: "Delete permanently", exact: true })
    .click();
  await owner.waitForURL(/#\/home$/);
  await owner
    .getByRole("heading", { name: "Keep a place of their own." })
    .waitFor();
  checks.push("deletion confirmation rejects wrong name and removes memorial");
  assert.deepEqual(errors, [], "browser page errors");
  await writeFile(
    resolve(out, "verification.json"),
    JSON.stringify(
      {
        status: "passed",
        checks,
        pageErrors: errors,
        emailsSent: 0,
        isolatedDatabase: true,
        nativeFileDialog: false,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify({
      status: "passed",
      checks: checks.length,
      emailsSent: 0,
      evidence: out,
    }),
  );
} catch (error) {
  console.error(error);
  console.error(logs);
  for (const context of browser.contexts())
    for (const page of context.pages())
      await page
        .screenshot({
          path: resolve(
            out,
            "failure-" + browser.contexts().indexOf(context) + ".png",
          ),
          fullPage: true,
        })
        .catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
  if (child) {
    const proc = child;
    await new Promise<void>((done) => {
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        done();
      }, 5000);
      proc.once("exit", () => {
        clearTimeout(timer);
        done();
      });
      proc.kill("SIGTERM");
    });
  }
  await rm(scratch, { recursive: true, force: true });
}
