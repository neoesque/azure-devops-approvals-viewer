# Approvals Viewer for Azure DevOps

A browser extension for viewing pending Azure DevOps Release and Pipeline
approvals across projects, including approvals waiting for you.

## Features

- View pending Release and Pipeline approvals across accessible projects.
- Consolidate approvals waiting for you into one tab.
- Highlight approvals assigned to the signed-in user.
- Open approval pages directly in Azure DevOps.
- Copy approval URLs for sharing.
- Show the last loaded approval list immediately, refresh on demand, and
  automatically refresh the first time the popup opens each day.
- Configure the Azure DevOps organization and API version.
- Optionally keep failed Azure DevOps tabs open for diagnosis.

## Install from Source

1. Download or clone this repository.
2. Open your browser's extension management page.
3. Enable Developer mode.
4. Select **Load unpacked** and choose the repository folder.
5. Open the extension settings and enter your Azure DevOps organization name.

The browser must already be signed in to an Azure DevOps account with access
to the configured organization.

## Permissions

The extension requests access only to:

- `storage`: Stores the configured organization name, API version, and last
  loaded approval list locally.
- `scripting`: Runs a temporary fetch helper inside Azure DevOps pages when
  Azure DevOps requires its own browser session service worker to attach
  authorization.
- `https://dev.azure.com/*`: Retrieves projects, user identity, and Pipeline
  approvals.
- `https://vsrm.dev.azure.com/*`: Retrieves Release approvals.

Approval data is processed and cached locally in the browser and is not sent
to developer-controlled servers.

## Debug Azure Authentication

When an Azure DevOps request fails, open **Settings**, enable **Keep failed
Azure DevOps tabs open**, save, then refresh the popup. A failed background tab
remains open so its final URL and Azure DevOps error page can be inspected. The
popup DevTools console logs either `[Azure DevOps auth bridge]` or
`[Azure DevOps release navigation]` with the attempted URL, final URL, title,
and error. It never logs cookies or authorization tokens.

Turn the option off after diagnosis; failed tabs are otherwise kept for
manual inspection.

## Privacy

See the [Privacy Policy](./privacy-policy.md).

## Disclaimer

Approvals Viewer for Azure DevOps is an independent tool. It is not affiliated
with, endorsed by, or sponsored by Microsoft.

Azure DevOps is a trademark of Microsoft Corporation.
