# meta-git

A script to build metabase collections and questions into filesystem hierarchy (folders & files), and automate git operations to sync metabase into a git based repo using the metabase api.

When you run the script, it will 
 - Create a directory (default is `repo/`) if doesnt exist, and initialize git repo.
 - Convert queries built via Metabase query builder to SQL
 - Write all collections and cards (with metadata) as files
 - Commit new changes
 - Archive repo as `.zip`
## setup
### pre requisites:
- [Bun](https://bun.sh)
- git

To install dependencies:

```bash
bun install
```

To run:
> Check Env vars at `.env.local_example`. Some are required. 

```bash
bun run server.js
```

Available flags:

- `--archive` builds zip archive of the repo to ./metabase-git-sync-***[[commit hash]]***.zip

## tech debt
> Also check code `TODO`'s
- http client config to set auth header globally
- compatibility in pathes and slashes
- OOP Tree, Node, Card, Collection + flexible walker (traversal algo)
