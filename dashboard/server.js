'use strict';

const express = require('express');
const Docker = require('dockerode');
const path = require('path');
const { randomUUID } = require('crypto');

const app = express();
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const HOST_IP = process.env.HOST_IP || 'localhost';
const NOVNC_PORT_START = parseInt(process.env.NOVNC_PORT_START || '6080', 10);
const ADB_PORT_START = parseInt(process.env.ADB_PORT_START || '5554', 10);
const MAX_EMULATORS = parseInt(process.env.MAX_EMULATORS || '5', 10);
const LABEL = 'android-emulator.managed';

const ANDROID_VERSIONS = {
  '34': { image: 'budtmo/docker-android:emulator_14.0', name: 'Android 14 (API 34)' },
  '33': { image: 'budtmo/docker-android:emulator_13.0', name: 'Android 13 (API 33)' },
  '31': { image: 'budtmo/docker-android:emulator_12.0', name: 'Android 12 (API 31)' },
  '30': { image: 'budtmo/docker-android:emulator_11.0', name: 'Android 11 (API 30)' },
  '29': { image: 'budtmo/docker-android:emulator_10.0', name: 'Android 10 (API 29)' },
  '28': { image: 'budtmo/docker-android:emulator_9.0',  name: 'Android 9 (API 28)'  },
};

// id must match a valid `avdmanager list device` ID; label is display-only
const EMULATOR_DEVICES = [
  { id: 'Nexus 5',    label: 'Nexus 5 (universal)'  },
  { id: 'Nexus 5X',   label: 'Nexus 5X'              },
  { id: 'Nexus 6P',   label: 'Nexus 6P'              },
  { id: 'pixel_2',    label: 'Pixel 2 (API 27+)'     },
  { id: 'pixel_3a',   label: 'Pixel 3a (API 29+)'    },
  { id: 'pixel_4',    label: 'Pixel 4 (API 29+)'     },
  { id: 'Galaxy Nexus', label: 'Galaxy Nexus'         },
];

// In-memory store for SSE launch progress jobs
const launchJobs = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// List all managed emulator containers
app.get('/api/emulators', async (req, res) => {
  try {
    const containers = await docker.listContainers({
      all: true,
      filters: JSON.stringify({ label: [`${LABEL}=true`] }),
    });

    const emulators = containers.map((c) => ({
      id: c.Id,
      shortId: c.Id.slice(0, 12),
      name: c.Labels['android-emulator.name'] || c.Names[0]?.replace('/', ''),
      androidVersion: c.Labels['android-emulator.version'],
      vncPort: parseInt(c.Labels['android-emulator.vnc-port'], 10),
      adbPort: parseInt(c.Labels['android-emulator.adb-port'], 10),
      status: c.State,
      vncUrl: `http://${HOST_IP}:${c.Labels['android-emulator.vnc-port']}`,
      adbCmd: `adb connect ${HOST_IP}:${c.Labels['android-emulator.adb-port']}`,
    }));

    res.json(emulators);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List available Android versions
app.get('/api/versions', (req, res) => {
  res.json(Object.entries(ANDROID_VERSIONS).map(([api, v]) => ({ api, ...v })));
});

// List available device types
app.get('/api/devices', (req, res) => {
  res.json(EMULATOR_DEVICES.map(({ id, label }) => ({ id, label })));
});

// Launch a new emulator — responds 202 + jobId immediately; pull/start runs in background
app.post('/api/emulators', async (req, res) => {
  const { androidVersion, device } = req.body;

  if (!ANDROID_VERSIONS[androidVersion]) {
    return res.status(400).json({ error: `Unknown Android version: ${androidVersion}` });
  }

  const validIds = EMULATOR_DEVICES.map((d) => d.id);
  const selectedDevice = (device && validIds.includes(device)) ? device : 'Nexus 5';

  try {
    const existing = await docker.listContainers({
      all: true,
      filters: JSON.stringify({ label: [`${LABEL}=true`] }),
    });

    if (existing.length >= MAX_EMULATORS) {
      return res.status(409).json({ error: `Maximum of ${MAX_EMULATORS} emulators reached` });
    }

    const usedVncPorts = new Set(existing.map((c) => parseInt(c.Labels['android-emulator.vnc-port'], 10)));
    const usedAdbPorts = new Set(existing.map((c) => parseInt(c.Labels['android-emulator.adb-port'], 10)));

    let vncPort, adbPort;
    for (let i = 0; i < MAX_EMULATORS; i++) {
      const cv = NOVNC_PORT_START + i;
      const ca = ADB_PORT_START + i * 2;
      if (!usedVncPorts.has(cv) && !usedAdbPorts.has(ca)) {
        vncPort = cv;
        adbPort = ca;
        break;
      }
    }

    if (!vncPort) {
      return res.status(409).json({ error: 'No free port slots available' });
    }

    const jobId = randomUUID();
    launchJobs.set(jobId, { buffered: [], sseRes: null, done: false });

    res.status(202).json({ jobId });

    // Helper: send SSE event (buffers if client not yet connected)
    const emit = (data) => {
      const job = launchJobs.get(jobId);
      if (!job) return;
      const line = `data: ${JSON.stringify(data)}\n\n`;
      if (job.sseRes) job.sseRes.write(line);
      else job.buffered.push(line);
    };

    // Background worker
    const { image, name } = ANDROID_VERSIONS[androidVersion];
    const containerName = `android-${androidVersion}-${Date.now()}`;

    (async () => {
      try {
        // Pull image
        await new Promise((resolve, reject) => {
          docker.pull(image, (err, stream) => {
            if (err) return reject(err);
            docker.modem.followProgress(
              stream,
              (err) => (err ? reject(err) : resolve()),
              (ev) => emit({
                phase: 'pulling',
                id: ev.id || '',
                status: ev.status || '',
                progressDetail: ev.progressDetail || {},
              })
            );
          });
        });

        emit({ phase: 'starting' });

        // Create and start container
        const volumeName = `android-avd-${containerName}`;

        const container = await docker.createContainer({
          Image: image,
          name: containerName,
          Env: [
            'WEB_VNC=true',
            `EMULATOR_DEVICE=${selectedDevice}`,
            'ADB_REMOTE_TRANSPORT=true',
          ],
          Labels: {
            [LABEL]: 'true',
            'android-emulator.version': androidVersion,
            'android-emulator.name': name,
            'android-emulator.vnc-port': String(vncPort),
            'android-emulator.adb-port': String(adbPort),
            'android-emulator.data-volume': volumeName,
          },
          HostConfig: {
            Devices: [{ PathOnHost: '/dev/kvm', PathInContainer: '/dev/kvm', CgroupPermissions: 'rwm' }],
            PortBindings: {
              '6080/tcp': [{ HostPort: String(vncPort) }],
              '5555/tcp': [{ HostPort: String(adbPort) }],
            },
            Mounts: [
              {
                Type: 'volume',
                Source: volumeName,
                Target: '/home/androidusr',
                ReadOnly: false,
              },
            ],
          },
          ExposedPorts: { '6080/tcp': {}, '5555/tcp': {} },
        });

        await container.start();

        emit({
          phase: 'done',
          containerId: container.id,
          name,
          androidVersion,
          vncPort,
          adbPort,
          vncUrl: `http://${HOST_IP}:${vncPort}`,
          adbCmd: `adb connect ${HOST_IP}:${adbPort}`,
        });
      } catch (err) {
        emit({ phase: 'error', message: err.message });
      } finally {
        const job = launchJobs.get(jobId);
        if (job) {
          job.done = true;
          if (job.sseRes) job.sseRes.end();
        }
      }
    })();

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SSE endpoint — streams pull/start progress for a launch job
app.get('/api/emulators/launch-progress/:jobId', (req, res) => {
  const job = launchJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Flush events buffered before SSE connected
  for (const line of job.buffered) res.write(line);
  job.buffered = [];
  job.sseRes = res;

  if (job.done) {
    res.end();
    launchJobs.delete(req.params.jobId);
    return;
  }

  req.on('close', () => {
    const j = launchJobs.get(req.params.jobId);
    if (j) {
      j.sseRes = null;
      if (j.done) launchJobs.delete(req.params.jobId);
    }
  });
});

// Boot status: 'booting' | 'booted' | docker state (exited/created/etc.)
app.get('/api/emulators/:id/status', async (req, res) => {
  try {
    const container = docker.getContainer(req.params.id);
    const info = await container.inspect();
    const dockerStatus = info.State.Status;

    if (dockerStatus !== 'running') {
      return res.json({ status: dockerStatus });
    }

    try {
      // getprop is an Android command — must be run via adb inside the container.
      // Each container has exactly one emulator, always reachable at emulator-5554 internally.
      const exec = await container.exec({
        Cmd: ['sh', '-c', 'adb -s emulator-5554 shell getprop sys.boot_completed 2>/dev/null'],
        AttachStdout: true,
        AttachStderr: false,
      });
      const stream = await exec.start({ hijack: true, stdin: false });
      const output = await new Promise((resolve) => {
        let buf = '';
        stream.on('data', (chunk) => { buf += chunk.toString(); });
        stream.on('end', () => resolve(buf));
        stream.on('error', () => resolve(''));
        setTimeout(() => resolve(buf), 5000);
      });
      res.json({ status: output.includes('1') ? 'booted' : 'booting' });
    } catch {
      res.json({ status: 'booting' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stream container logs as SSE
app.get('/api/emulators/:id/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const container = docker.getContainer(req.params.id);

  container.logs({ follow: true, stdout: true, stderr: true, tail: 200 }, (err, stream) => {
    if (err) {
      res.write(`data: ${JSON.stringify({ msg: `Error: ${err.message}` })}\n\n`);
      res.end();
      return;
    }

    const sendChunk = (chunk) => {
      const lines = chunk.toString()
        .replace(/\x1b\[[0-9;]*[mGKHF]/g, '')  // strip ANSI codes
        .replace(/\r/g, '')
        .split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) res.write(`data: ${JSON.stringify({ msg: trimmed })}\n\n`);
      }
    };

    docker.modem.demuxStream(stream, { write: sendChunk }, { write: sendChunk });
    stream.on('end', () => res.end());
    req.on('close', () => stream.destroy());
  });
});

// Restart a stopped emulator container
app.post('/api/emulators/:id/start', async (req, res) => {
  try {
    await docker.getContainer(req.params.id).start();
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stop and remove an emulator (and its data volume)
app.delete('/api/emulators/:id', async (req, res) => {
  try {
    const container = docker.getContainer(req.params.id);
    const info = await container.inspect();
    const volumeName = info.Config.Labels['android-emulator.data-volume'];
    try { await container.stop({ t: 5 }); } catch { /* already stopped */ }
    await container.remove();
    if (volumeName) {
      try { await docker.getVolume(volumeName).remove(); } catch { /* ignore */ }
    }
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Dashboard running on http://0.0.0.0:${PORT}`);
  console.log(`Host IP: ${HOST_IP}`);
  prePullImages();
});

// Pre-pull all Android images sequentially on startup so first launches are fast
async function prePullImages() {
  console.log('[pre-pull] Starting background image pre-pull...');
  for (const [, { image, name }] of Object.entries(ANDROID_VERSIONS)) {
    console.log(`[pre-pull] ${name} (${image})...`);
    await new Promise((resolve) => {
      docker.pull(image, (err, stream) => {
        if (err) { console.error(`[pre-pull] Failed: ${err.message}`); return resolve(); }
        docker.modem.followProgress(
          stream,
          () => { console.log(`[pre-pull] Done: ${image}`); resolve(); },
          () => {}
        );
      });
    });
  }
  console.log('[pre-pull] All images ready.');
}
