# Security policy

The trust this project provides depends on the agent and reproducer behaving
exactly as published, so security reports are taken seriously.

## Reporting a vulnerability

Report privately through GitHub's private vulnerability reporting (the "Report a
vulnerability" button under the Security tab), or by email to
jason@adastracomputing.com. Do not open a public issue for a vulnerability.

Include the affected file or workflow, the conditions required to trigger it, and
the impact. A proof of concept helps. You will get an acknowledgement within a
few days.

## Scope

This repository is the client-side agent and reproducer. The reproducer builds
untrusted Nix code on a runner that can attest to Vega, so reports about the
isolation between an untrusted build and the attestation credential (the GitHub
OIDC token) are especially in scope. The control plane is a separate system.
