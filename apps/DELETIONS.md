# App deletion confirmations

A removed `apps/<slug>/` directory is not enough to destroy a production app.
The reconciler requires an active line in this file with the exact slug:

```text
DELETE <slug>
```

Add a confirmation only in the change that intentionally removes the app. Remove
stale confirmations after the deletion has completed so they cannot authorize a
future unrelated removal.
