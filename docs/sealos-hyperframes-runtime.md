# Sealos HyperFrames runtime repair

Issue [#5](https://github.com/prime-optimal/stream-machine/issues/5), linked to [plugin #44](https://github.com/prime-optimal/stream-machine-plugin/issues/44).

The standalone Sealos daemon has bundled HyperFrames and FFmpeg but lacks a browser. The packaged Electron renderer is a local sidecar capability; connecting a browser to remote Studio does not register a desktop renderer.

`deploy/Dockerfile.hyperframes` extends the exact existing deployed image. It adds distribution Chromium plus command-line FFmpeg/FFprobe and sets `HYPERFRAMES_BROWSER_PATH` to verified ELF executable `/usr/lib/chromium/chromium`, selecting the daemon's existing headless render branch. The bundled FFmpeg library is not sufficient for the CLI's PATH checks. Alpine's `/usr/bin/chromium-browser` is a shell launcher, unsuitable for the pinned HyperFrames musl loader. It does not replace application source, build a separate renderer, or change authentication, startup commands, workload environment, storage, or resource limits. UID/GID remains1001.

Build uses existing registry keychain credentials:

```sh
docker build --platform linux/amd64 -t stream-machine:hyperframes - < deploy/Dockerfile.hyperframes
```

Before rollout, verify Chromium as runtime user and render an isolated small composition through the bundled daemon media dispatcher. Decode MP4 and verify visible frames, dimensions and duration. Test within existing workload limits. Do not install packages in running pod or mount live storage into smoke containers.

Read root [daemon data directory contract](../AGENTS.md#daemon-data-directory-contract) for persistence. Keep full secret-bearing workload configuration and rollback records outside repository in owner-only storage. Publish commit-tagged image, resolve digest, then change only existing StatefulSet container image. Preserve original immutable digest for rollback. A derivative using identical application bytes needs no schema migration.

Initial native dispatcher smoke exposed absent runtime-user home: Chromium crashpad could not select writable configuration. Image now creates owner-only home with user-owned browser/HyperFrames cache directories. No process sandbox flags or workload security settings changed.

November1 native Linux x86_64 acceptance passed against Dockerfile revision `68310af876`: Chromium155.0.8059.84, distribution FFmpeg8.1.3; actual bundled daemon `generateMedia()` with no desktop callback produced H264 MP4,320×180,1.000second,30frames,25,398bytes. Decoded frames contain22unique hashes and visible title fade/hold/fade. Container ran as1001:1001 with network disabled,0.5CPU and1GiB memory, matching existing workload limits. Local bundled GSAP avoided network assets. No live volume was mounted.

Initial local OrbStack extraction hit host disk exhaustion. Validation moved to existing native NAS Docker context. Only task-owned failed containers/candidate image tags were removed locally; no user image, container, volume or broad cache prune occurred. Live rollout remains a separate gate after immutable publication and review.

Verified candidate published as `harbor.usw-1.sealos.io/ns-sjkkuwc0/stream-machine@sha256:9edea53714c49b24044e2e6857d38be36a802d5c5550d961aa1a35fc4f6ca80b`, tagged `hyperframes-68310af876`. Existing source and review records committed before image-only workload update.
