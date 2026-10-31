import type { Page } from "playwright-core";
import { identityHeaders } from "./sites-verification.ts";

// This loopback edge fixture stands in for Sites dispatch, never for app authorization.
export async function signInFixture(
  page: Page,
  origin: string,
  email: string,
  name: string,
  path = "/#/home",
) {
  if (!["127.0.0.1", "localhost"].includes(new URL(origin).hostname))
    throw Error("Identity fixtures are local-only.");
  await page.route(origin + "/signin-with-chatgpt?**", async (route) => {
    const requested =
      new URL(route.request().url()).searchParams.get("return_to") || "/";
    const target = new URL(requested, origin);
    if (target.origin !== origin) throw Error("Unsafe sign-in return path.");
    await route.fulfill({ status: 302, headers: { Location: target.href } });
  });
  await page.goto(origin + "/#/login?next=" + encodeURIComponent(path));
  const link = page.getByRole("link", {
    name: "Sign in with ChatGPT",
    exact: true,
  });
  await link.waitFor();
  if ((await link.getAttribute("target")) !== "_top")
    throw Error("Sites sign-in must use top-level navigation.");
  await page.context().setExtraHTTPHeaders(identityHeaders(email, name));
  await link.click();
  await page.waitForURL((url) => url.hash === path.slice(1));
  await page.waitForFunction(
    () =>
      document.body.dataset.route ===
      (location.hash.startsWith("#/p/") || location.hash === "#/"
        ? "park"
        : location.hash.slice(2).split(/[?\/]/)[0]),
  );
}
