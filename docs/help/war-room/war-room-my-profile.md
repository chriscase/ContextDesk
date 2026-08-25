---
id: war-room-my-profile
title: Update your War Room profile
summary: Open My profile to see your current identity, edit workspace-owned fields, and leave historical attribution unchanged.
section: war-room
tags:
  - war-room
  - identity
  - profile
  - ldap
  - collaboration
order: 25
related:
  - war-room-workflow
  - war-room-deployment
---

# Update your War Room profile

My profile is the signed-in page at `/profile`. Open it from the account menu
in the War Room header. Direct load, reload, Back, and Forward keep that
address.

## What you see

The page shows your current display name, username, role title, team, contact
details, avatar metadata, account status, profile source (local account, LDAP
directory, or OIDC sign-in provider), directory sync state and time, and the
revision used when saving.

A workspace **role** (viewer, contributor, case-lead, or admin) is a bundle of
**capabilities** such as reading investigations or administering people. Roles
and capabilities decide what you can do. My profile only changes how you appear
from now on.

## What you can edit

| Account source | Editable here | Read-only here |
| --- | --- | --- |
| Local account | Display name, role title, team, work email, other contact, avatar, custom fields | Username, account status, profile source, revision |
| LDAP or OIDC | Other contact, avatar, and custom fields that live only in this workspace | Display name, role title, team, and work email — the directory owns those |

This page never contacts LDAP and cannot change directory records. Directory-
owned fields stay visible so you can recognize your account.

## Saving and history

Save sends only the fields you are allowed to change, with a revision check so
two overlapping edits cannot silently overwrite each other. If the saved
profile changed while you were editing, your draft stays; you can reload the
saved profile or review it and save again.

Changing your display name does **not** rewrite notes, comments, decisions, or
other records already written. Those keep the author name captured at write
time.

> Important:
> A suspended account can still open My profile but cannot save until an
> administrator restores it.
