# Verifying it works

A manual pass against a real Railway account, in the order that exercises the most ground.
The automated equivalents are in [Tests](testing.md); this is what a reviewer runs by hand.

1. **Sign in.** Railway's consent screen should list your projects — select at least one.
2. **Spin up `redis:7-alpine`.** The row should move Queued → Building → Deploying → Running,
   with build output streaming in the expanded log pane.
3. **Stop it.** The badge should settle at **Removed** while the row stays on the dashboard —
   the service, its variables and its history are all still on Railway. The row's controls
   change with it: Stop and Restart give way to Redeploy. Press that and it should come back
   Queued → Building → Deploying → Running. Then press **Restart** on the running container
   with its log pane open: the pane keeps filling, because a restart keeps the same deployment
   rather than starting a new one.
4. **Destroy it** (type the container name to confirm) and check it disappears from the Railway
   dashboard too.
5. **Several at once.** Spin up three, tick their checkboxes and press **Destroy selected**. The
   confirmation names the count and lists the names, and asks for the count rather than three
   names — friction proportionate to the batch instead of multiplied by it. Ownership is still
   re-derived per service on the server: the unmanaged row has no checkbox, and
   `actions.integration.test.ts` proves a forged service id in a batch is refused on its own
   while the rest go through.
6. **Sorting.** Change **Sort** and confirm the URL gains `?sort=`, the order changes with no
   request to Railway, and reloading the page keeps it. Then press **Clear filters**: the search
   and status params go and the sort stays, because it hides nothing and has its own default.
7. **Token expiry.** Leave the tab open past the hour, or rewind `expiresAt` in the session
   cookie, then perform an action. It should succeed — the proxy refreshes and rotates
   transparently.
8. **Ownership.** Create a service in the Railway dashboard directly. It appears here as _Not
   managed here_, with no lifecycle controls at all — no stop, restart, redeploy or destroy, and
   no selection checkbox either.
9. **The way out.** Click any container's name — every row, not only the broken ones — and confirm
   it opens that service on Railway in a new tab. The chevron beside it is the log panel's
   disclosure; check it still expands from the keyboard.
10. **Failure paths.** Type `nonexistent/image:tag` and confirm the field warns beside it after a
    beat — then confirm the warning changes nothing else: the field is not marked invalid, the
    submit button is live, and submitting still creates the container. That is the whole point of
    the check being advisory. It settles into **Failed** rather than spinning forever, and
    expanding the row explains the failure and repeats **Open in Railway**. Do not expect build
    logs here: an image source performs no build, and a pull that never resolves may write nothing
    to either log phase — which is exactly why the row carries an explanation and a deep link.
    Reload the page and expand the row again; if Railway did write output to the other phase, the
    monitor's fallback fetches it. Then revoke the app's authorization mid-session and confirm you
    are sent back to sign in with an explanation, not a stack trace.

---

[Walkthrough](../walkthrough.md) · [Railway Freight Loader](../README.md)
