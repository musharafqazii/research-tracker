"""End-to-end browser test of the tracker in its browser-only preview mode, playing both roles.
Run: python3 tests/e2e.py   (needs Playwright; external scripts are blocked so it runs offline)"""
import asyncio, json, os, sys
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
URL = "file://" + os.path.join(ROOT, "index.html")
SHOTS = os.environ.get("SHOTS", "/tmp/rt-shots")
os.makedirs(SHOTS, exist_ok=True)
LEAF = "theory~homogeneous-case~free-field"

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path="/opt/pw-browsers/chromium")
        ctx = await browser.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True)
        page = await ctx.new_page()
        errors = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "net::ERR" not in m.text and "Failed to load resource" not in m.text else None)
        page.on("pageerror", lambda e: errors.append("PAGEERROR " + str(e)))
        await page.route("**/*", lambda r: r.continue_() if r.request.url.startswith("file://") else r.abort())
        await page.goto(URL)
        await page.wait_for_timeout(400)

        async def role(r):
            await page.click(f'#rolePreview button[data-role="{r}"]')
            await page.wait_for_timeout(150)
        async def open_item(item_id):
            await page.evaluate(f"location.hash = '#outline/{item_id}'")
            await page.wait_for_timeout(250)
        async def panel():
            return page.locator(f'li[data-id="{LEAF}"] > .ipanel')
        async def text(sel):
            return (await page.text_content(sel)) or ""
        def check(cond, msg):
            print(("PASS " if cond else "FAIL ") + msg)
            if not cond: raise SystemExit(1)

        check("browser only" in (await text("#statusText")), "local preview mode")
        await role("student")
        check((await text("#roleBadge")) == "Student", "role badge says Student")
        await page.screenshot(path=f"{SHOTS}/1-today-student.png", full_page=True)

        # ---- student works the item
        await open_item(LEAF)
        pn = await panel()
        check(await pn.is_visible(), "item panel opens from a deep link")
        check("hasn't written this yet" in await pn.text_content(), "student sees the deliverable is not written")
        check(await pn.locator(".status-box button.ok").count() == 0, "student has no Approve button")
        await pn.locator("button:has-text('Start: Derive')").click(); await page.wait_for_timeout(120)
        check(await pn.locator(".strip li.cur", has_text="Derive").count() == 1, "one click starts the item")
        await pn.locator("button:has-text('Done with Derive')").click(); await page.wait_for_timeout(120)
        check(await pn.locator(".strip li.cur", has_text="Implement").count() == 1, "next-step button moves it on")
        await pn.locator(".checksel").select_option("regulated"); await page.wait_for_timeout(120)
        check(await pn.locator(".checksel").input_value() == "regulated", "student records Regulated")
        check(await pn.locator(".checksel option[value=independent]").is_disabled(), "student can't record an independent check")
        await pn.locator(".strip button", has_text="Interpret").click(); await page.wait_for_timeout(120)
        await pn.locator("button:has-text('Send for review')").first.click(); await page.wait_for_timeout(200)
        check("With your guide for review" in await pn.text_content(), "sent for review")
        check(await pn.locator(".strip button").count() == 0, "stage locked while with the guide")

        # ---- guide reviews
        await role("guide")
        check((await text("#roleBadge")) == "Guide", "role badge says Guide")
        await page.screenshot(path=f"{SHOTS}/2-review-guide.png", full_page=True)
        check("Free Field" in await text("#view-today") and "Review now" in await text("#view-today"), "guide's Home lists the item under Review now")
        await open_item(LEAF); pn = await panel()
        check(await pn.locator("button:has-text('Send for review')").count() == 0, "guide has no Send for review")
        await pn.locator(".spec button:has-text('Write it')").click(); await page.wait_for_timeout(150)
        await pn.locator("textarea[aria-label='What exactly to produce']").fill("|β_k|² for the free field across the transition, k from 1e-3 to 1e2 H, adiabatic order-4 out-state.")
        await pn.locator("textarea[aria-label=\"How you'll judge it (optional)\"]").fill("Reproduces the sudden limit; initial-time independent to 1%.")
        await pn.locator(".spec button:has-text('Save')").click(); await page.wait_for_timeout(200)
        check("Reproduces the sudden limit" in await pn.text_content(), "guide wrote the deliverable")
        await pn.locator("button:has-text('Request changes…')").click()
        await pn.locator("button:has-text('Send change request')").click(); await page.wait_for_timeout(100)
        check(await pn.locator("textarea[aria-label='What needs to change']").evaluate("e => e.classList.contains('invalid')"), "a change request needs a note")
        await pn.locator("textarea[aria-label='What needs to change']").fill("Check the sign of the cross term in eq. 12")
        await pn.locator("button:has-text('Send change request')").click(); await page.wait_for_timeout(200)
        check("Changes requested" in await pn.text_content(), "changes requested")

        # ---- student resubmits, guide approves and checks
        await role("student"); await open_item(LEAF); pn = await panel()
        check("Check the sign of the cross term" in await pn.text_content(), "student sees the change note")
        await pn.locator("button:has-text('Send for review again')").first.click(); await page.wait_for_timeout(200)
        await role("guide"); await open_item(LEAF); pn = await panel()
        await pn.locator("button.ok.solid:has-text('Approve')").first.click(); await page.wait_for_timeout(200)
        check("Approved" in await pn.locator(".status-box").text_content(), "approved")
        check("ph-approved" in (await page.get_attribute(f'li[data-id="{LEAF}"] > .row .sg', "class")), "row shows the approved mark")
        for lvl in ["converged", "independent", "publication"]:
            await pn.locator(".checksel").select_option(lvl); await page.wait_for_timeout(150)
        check(await pn.locator(".checksel").input_value() == "publication", "guide records publication-ready")

        # ---- guide adds a deliverable under a section
        sec = "theory~perturbation"
        await open_item(sec)
        sp = page.locator(f'li[data-id="{sec}"] > .ipanel')
        await sp.locator("input[aria-label='New deliverable title']").fill("Second-order source term in the WKB basis")
        await sp.locator("button:has-text('Add deliverable')").click(); await page.wait_for_timeout(400)
        check(await page.locator(".node.dlv .title", has_text="Second-order source term").count() == 1, "new deliverable appears in the outline")

        # ---- student invalidates the approved result
        await role("student"); await open_item(LEAF); pn = await panel()
        await pn.locator("summary", has_text="More options").click()
        await pn.locator("button:has-text('The result is wrong…')").click()
        await pn.locator("textarea[aria-label=\"What's wrong with the result\"]").fill("The mode sum didn't converge at higher cutoff")
        await pn.locator("button:has-text('Mark result wrong')").last.click(); await page.wait_for_timeout(200)
        t = await pn.text_content()
        check("Result marked wrong" in t, "invalidated result goes back to the student")
        check(await pn.locator(".checksel").input_value() == "unchecked", "its verification is cleared")

        # ---- meetings and decisions respect who may answer
        await page.evaluate("location.hash = '#meetings'"); await page.wait_for_timeout(200)
        await page.fill("#view-meetings textarea[aria-label='Decision']", "Which initial time η₀ for the numerics?")
        await page.click("#view-meetings button[data-kind='request']"); await page.wait_for_timeout(200)
        check(await page.locator("#decOpen textarea").count() == 0, "the requester can't decide their own request")
        await role("guide"); await page.evaluate("location.hash = '#meetings'"); await page.wait_for_timeout(200)
        check(await page.locator("#decOpen textarea").count() == 1, "the guide can decide it")
        await page.fill("#decOpen textarea", "η₀ = −10/H"); await page.click("#decOpen button:has-text('Record decision')"); await page.wait_for_timeout(200)
        check("η₀ = −10/H" in await text("#decDone"), "decision recorded")

        # ---- daily log + weekly report
        await role("student"); await page.evaluate("location.hash = '#log'"); await page.wait_for_timeout(250)
        await page.fill("textarea[aria-label='What I actually did']", "Redid the mode sum with a higher cutoff")
        await page.fill("input[aria-label='Hours on Theory']", "3")
        await page.click("#view-log button[type=submit]"); await page.wait_for_timeout(250)
        rep = await text("#report")
        for needle in ["Completed (approved)", "Failed or invalidated", "Result invalidated", "Theory: 3 h", "Deliverables", "Verification", "Decisions"]:
            check(needle in rep, "weekly report shows: " + needle)
        await page.screenshot(path=f"{SHOTS}/3-log.png", full_page=True)

        # ---- exports
        async with page.expect_download() as d:
            await page.click("#moreBtn"); await page.click("#moreMenu button[data-act='snapshot']")
        md = open(await (await d.value).path()).read()
        for needle in ["## Outline and deliverables", "Deliverable: |β_k|²", "## Review history", "requested changes on", "## Decisions", "## Daily log", "## Activity log", "Second-order source term"]:
            check(needle in md, "snapshot contains: " + needle)
        async with page.expect_download() as d:
            await page.click("#moreBtn"); await page.click("#moreMenu button[data-act='backup']")
        bk = json.load(open(await (await d.value).path()))
        check(bk["items"][LEAF]["verify"] == "unchecked" and len(bk["events"]) > 10 and len(bk["deliverables"]) == 1, "backup holds items, events and deliverables")

        # ---- every view renders for both roles, and nothing scrolls sideways on a phone
        for r in ["student", "guide"]:
            await role(r)
            for v in ["today", "outline", "meetings", "log", "manuscript"]:
                await page.evaluate(f"location.hash = '#{v}'"); await page.wait_for_timeout(120)
                check(len((await text(f"#view-{v}")).strip()) > 20, f"{r}: {v} renders")
        await page.set_viewport_size({"width": 390, "height": 844})
        for v in ["today", "outline", "meetings", "log", "manuscript"]:
            await page.evaluate(f"location.hash = '#{v}'"); await page.wait_for_timeout(150)
            sw = await page.evaluate("document.documentElement.scrollWidth")
            check(sw <= 392, f"phone width: {v} has no sideways scroll ({sw}px)")
        await open_item(LEAF)
        await page.screenshot(path=f"{SHOTS}/4-item-phone.png", full_page=False)
        await page.emulate_media(color_scheme="dark"); await page.set_viewport_size({"width": 1280, "height": 900})
        await open_item(LEAF); await page.wait_for_timeout(200)
        await page.screenshot(path=f"{SHOTS}/5-item-dark.png", full_page=False)

        check(not errors, "no console errors: " + "; ".join(errors[:5]))
        await browser.close()

asyncio.run(main())
