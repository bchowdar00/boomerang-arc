// Where the visitor is, kept in the address bar's hash so the app can be served as plain files
// from any host with no rewrite rules: #/ , #/campaign/3 , #/campaign/3/pledge , #/mine , #/proof
export type Route =
  | { page: "home" }
  | { page: "campaign"; id: bigint }
  | { page: "pledge"; id: bigint }
  | { page: "mine" }
  | { page: "proof" }
  | { page: "lost"; hash: string };

const ID = /^[1-9][0-9]{0,17}$/; // a campaign id: a whole number from 1, small enough to be an id

/** The route a hash names. Anything not understood is "lost", with what was asked for. */
export function routeOf(hash: string): Route {
  const path = hash.replace(/^#/, "").replace(/^\/+|\/+$/g, "");
  if (path === "") return { page: "home" };
  const parts = path.split("/");
  if (parts.length === 1 && parts[0] === "mine") return { page: "mine" };
  if (parts.length === 1 && parts[0] === "proof") return { page: "proof" };
  if (parts[0] === "campaign" && parts.length >= 2 && ID.test(parts[1])) {
    const id = BigInt(parts[1]);
    if (parts.length === 2) return { page: "campaign", id };
    if (parts.length === 3 && parts[2] === "pledge") return { page: "pledge", id };
  }
  return { page: "lost", hash };
}

/** The hash that names a route; `routeOf(hrefFor(r))` is `r` again. */
export function hrefFor(route: Route): string {
  switch (route.page) {
    case "home":
      return "#/";
    case "campaign":
      return `#/campaign/${route.id}`;
    case "pledge":
      return `#/campaign/${route.id}/pledge`;
    case "mine":
      return "#/mine";
    case "proof":
      return "#/proof";
    case "lost":
      return route.hash;
  }
}
