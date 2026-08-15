import actionScopeLabel from "./action-scope-label.mjs";
import mutationInsideOwnershipGuard from "./mutation-inside-ownership-guard.mjs";
import noCookieJarDelete from "./no-cookie-jar-delete.mjs";
import noFunctionFormAction from "./no-function-form-action.mjs";
import noServerImportsInClient from "./no-server-imports-in-client.mjs";

/**
 * The rules this repo needs and no linter ships.
 *
 * Four of them replace a test that asserted the same invariant by reading source files as
 * text. The move is not about tidiness: a lint rule reports at the moment of typing and
 * names its own fix, where those tests reported in CI, named an assertion rather than a
 * rule, and — because they matched paths and byte offsets — dictated which file the code
 * they guarded had to live in.
 *
 * `no-function-form-action` replaces nothing, which is why it exists. The bug it bans
 * shipped twice and no test could tell the broken behaviour from the fixed one, because
 * what it breaks is a control's value on a path no assertion looked at.
 *
 * What stayed a test is everything a per-file rule cannot see: transitive reachability
 * across the import graph, agreement between two files, and anything about CSS, YAML or
 * the Dockerfile.
 */
const plugin = {
  rules: {
    "action-scope-label": actionScopeLabel,
    "mutation-inside-ownership-guard": mutationInsideOwnershipGuard,
    "no-cookie-jar-delete": noCookieJarDelete,
    "no-function-form-action": noFunctionFormAction,
    "no-server-imports-in-client": noServerImportsInClient,
  },
};

export default plugin;
