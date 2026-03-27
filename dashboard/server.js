'use strict';

const express = require('express');
const Docker = require('dockerode');
const path = require('path');

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
};

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
  res.json(
    Object.entries(ANDROID_VERSIONS).map(([api, v]) => ({ api, ...v }))
  );
});

// Launch a new emulator
app.post('/api/emulators', async (req, res) => {
  const { androidVersion } = req.body;

  if (!ANDROID_VERSIONS[androidVersion]) {
    return res.status(400).json({ error: `Unknown Android version: ${androidVersion}` });
  }

  try {
    // Find used ports
    const existing = await docker.listContainers({
      all: true,
      filters: JSON.stringify({ label: [`${LABEL}=true`] }),
    });

    if (existing.length >= MAX_EMULATORS) {
      return res.status(409).json({ error: `Maximum of ${MAX_EMULATORS} emulators reached` });
    }

    const usedVncPorts = new Set(
      existing.map((c) => parseInt(c.Labels['android-emulator.vnc-port'], 10))
    );
    const usedAdbPorts = new Set(
      existing.map((c) => parseInt(c.Labels['android-emulator.adb-port'], 10))
    );

    // Find next free slot
    let vncPort, adbPort;
    for (let i = 0; i < MAX_EMULATORS; i++) {
      const candidateVnc = NOVNC_PORT_START + i;
      const candidateAdb = ADB_PORT_START + i * 2;
      if (!usedVncPorts.has(candidateVnc) && !usedAdbPorts.has(candidateAdb)) {
        vncPort = candidateVnc;
        adbPort = candidateAdb;
        break;
      }
    }

    if (!vncPort) {
      return res.status(409).json({ error: 'No free port slots available' });
    }

    const { image, name } = ANDROID_VERSIONS[androidVersion];
    const containerName = `android-${androidVersion}-${Date.now()}`;

    // Pull the image if not already present locally
    await new Promise((resolve, reject) => {
      docker.pull(image, (err, stream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (err) => err ? reject(err) : resolve());
      });
    });

    const container = await docker.createContainer({
      Image: image,
      name: containerName,
      Env: [
        'WEB_VNC=true',
        'EMULATOR_DEVICE=Samsung Galaxy S10',
        `ADB_REMOTE_TRANSPORT=true`,
      ],
      Labels: {
        [LABEL]: 'true',
        'android-emulator.version': androidVersion,
        'android-emulator.name': `${name}`,
        'android-emulator.vnc-port': String(vncPort),
        'android-emulator.adb-port': String(adbPort),
      },
      HostConfig: {
        Devices: [
          {
            PathOnHost: '/dev/kvm',
            PathInContainer: '/dev/kvm',
            CgroupPermissions: 'rwm',
          },
        ],
        PortBindings: {
          '6080/tcp': [{ HostPort: String(vncPort) }],
          '5555/tcp': [{ HostPort: String(adbPort) }],
        },
      },
      ExposedPorts: {
        '6080/tcp': {},
        '5555/tcp': {},
      },
    });

    await container.start();

    res.status(201).json({
      id: container.id,
      shortId: container.id.slice(0, 12),
      name: `${name}`,
      androidVersion,
      vncPort,
      adbPort,
      status: 'running',
      vncUrl: `http://${HOST_IP}:${vncPort}`,
      adbCmd: `adb connect ${HOST_IP}:${adbPort}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stop and remove an emulator
app.delete('/api/emulators/:id', async (req, res) => {
  try {
    const container = docker.getContainer(req.params.id);
    try {
      await container.stop({ t: 5 });
    } catch (e) {
      // Already stopped — ignore
    }
    await container.remove();
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Dashboard running on http://0.0.0.0:${PORT}`);
  console.log(`Host IP: ${HOST_IP}`);
});
