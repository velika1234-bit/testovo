# Firestore rules deployment (required for admin panel)

If the admin panel shows `Missing or insufficient permissions`, the latest rules are likely **not deployed** yet.

## 1) Login and select project

```bash
firebase login
firebase use videoquiz-ultimate
```

## 2) Deploy only Firestore rules

```bash
firebase deploy --only firestore:rules
```

## 3) Quick verification

- Open app, click **Админ панел**
- In browser console you should no longer see `permission-denied`
- Ensure your teacher profile has `accessLevel: "admin"` in:
  - `artifacts/videoquiz-ultimate-live/users/<uid>/settings/profile`

## Notes

- `firebase.json` points to `firestore.rules`.
- App-side admin button visibility is UID-based, but Firestore still enforces rules server-side.
