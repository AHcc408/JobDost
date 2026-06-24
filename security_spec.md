# Security Specification - JobDost

## Data Invariants
1. **User Identity Isolation**: A user can only access their own profile, messages, and job matches.
2. **Message Integrity**: Messages must have a valid role ('user' or 'model') and a non-empty text body.
3. **Immutability**: Document IDs used for relations (like `userId` in paths) must match the authenticated user's UID.
4. **Verified Access**: All write operations require a verified email address to prevent spam/abuse from unverified accounts.

## Dirty Dozen Payloads (Target: Permission Denied)
1. **Identity Spoofing**: Attempt to write to `users/target-uid` with a different `auth.uid`.
2. **Access Escalation**: Attempt to read `users/other-uid/messages`.
3. **Invalid Role**: Write a message with `role: 'admin'`.
4. **Huge Data Attack**: Write a `text` block larger than 10KB.
5. **ID Poisoning**: Use a document ID with special characters like `../` or very long strings.
6. **Unverified Write**: Attempt to update profile while `email_verified` is `false`.
7. **System Field Injection**: Attempt to overwrite a server-side timestamp or `uid` field with a custom value.
8. **Shadow Field**: Adding a `role: 'admin'` field to a User profile document.
9. **Query Scrape**: Listing all `users` without a specific UID filter.
10. **State Shortcut**: Updating a job match status to 'saved' when it doesn't belong to the user.
11. **Malicious Link**: Injecting a 1MB string into a `matches[0].link` field.
12. **Orphaned Message**: Creating a message in a path where the user document doesn't exist yet (handled by relation exists check).

## Audit Report
- **Identity Spoofing**: PASS (Enforced via `isOwner(userId)`)
- **State Shortcutting**: PASS (Enforced via `isValidMatch` and `affectedKeys()`)
- **Resource Poisoning**: PASS (Enforced via `.size()` checks on all strings)
- **PII Leakage**: PASS (Relational isolation ensures PII is only visible to owner)
