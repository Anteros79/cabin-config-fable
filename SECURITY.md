# Security

Cabin Kit is a fictional home-lab demonstration. It is not an approved maintenance authority and holds no real aircraft data.

## Threat model

- The server listens on the loopback interface only (`127.0.0.1`). Do not expose it to a network.
- There is no authentication and no user accounts. Anyone who can reach the port can read and write visits.
- Data is stored in a local SQLite file under `data/`. Stored snapshots, reports and events are immutable.

## Host and Origin checks

> Placeholder: Task 1.1 adds the Host and Origin checks and will describe here exactly which requests they accept and reject. Until then, no such checks exist and loopback binding is the only protection.

## Reporting a problem

Open a private security advisory on the GitHub repository, or contact the maintainer directly. Please include the version or commit, steps to reproduce, and the impact you expect. Do not post details in a public issue until a fix is available.
