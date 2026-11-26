# The built-in network directory

`directory.json` lists the networks (tailnets) every packaged Lazurio App may join when neither IT's policy nor the person's own setting names any (docs/adr/0008, `TailnetDirectory.ts`). It is a bridge until Lazurio Auth's network directory serves each person's own networks (#55).

Being listed grants nothing: a network's control server admits only members of its Organization, and the Organization's Admin approves each computer.

## Adding the network of an Organization being onboarded

Add one object to the array, with exactly these fields:

```json
{
  "tailnet": "<the network's name, as its Headscale and Lazurio Auth know it>",
  "controlUrl": "https://headscale.<organization>.lazurio.io",
  "domains": ["<organization>.lazurio.io"]
}
```

- `controlUrl` and every name in `domains` must lie below `lazurio.io` or `lazurio.ai`. The app refuses anything else.
- One domain covers every name below it, for example `launchpad.<environment>.<organization>.lazurio.io` and `tailnet.<organization>.lazurio.io`.
- Keep `lazurioexampleorganization`, Lazurio's own example. While it is the only entry, a stable build tells the person that their Organization's network is not set up.
- Nothing else goes here: no person's name and no other data about the customer.

A new entry reaches people only with a new release of the app.
