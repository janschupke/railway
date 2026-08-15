import actionScopeLabel from "./action-scope-label.mjs";
import mutationInsideOwnershipGuard from "./mutation-inside-ownership-guard.mjs";
import noCookieJarDelete from "./no-cookie-jar-delete.mjs";
import noServerImportsInClient from "./no-server-imports-in-client.mjs";

/**
 * The rules this repo needs and no linter ships.
 *
 * Each one replaces a test that asserted the same invariant by reading source files as
 * text. The move is not about tidiness: a lint rule reports at the moment of typing and
 * names its own fix, where those tests reported in CI, named an assertion rather than a
 * rule, and — because they matched paths and byte offsets — dictated which file the code
 * they guarded had to live in.
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
    "no-server-imports-in-client": noServerImportsInClient,
  },
};

export default plugin;
