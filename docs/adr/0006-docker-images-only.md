# ADR-6 — Docker images only; GitHub sources are a stated limitation

`serviceCreate` accepts `source.image` or `source.repo`. Repo sources silently require
_the signed-in user's_ Railway account to have the GitHub app installed with access to
that repo — something this app cannot provision on their behalf. Image sources work for
anyone, so that is the product surface. See "Limitations".

---

[All decisions](README.md) · [Railway Freight Loader](../../README.md)
