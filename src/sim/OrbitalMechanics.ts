export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface OrbitalElements {
  readonly mu: number;
  readonly radiusM: number;
  readonly altitudeM: number;
  readonly orbitalSpeedMps: number;
  readonly radialSpeedMps: number;
  readonly tangentialSpeedMps: number;
  readonly circularVelocityMps: number;
  readonly specificEnergy: number;
  readonly semiMajorAxisM: number;
  readonly eccentricity: number;
  readonly apoapsisRadiusM: number;
  readonly periapsisRadiusM: number;
  readonly apoapsisAltM: number;
  readonly periapsisAltM: number;
  readonly orbitalPeriodS: number | null;
  readonly timeToApoapsisS: number | null;
  readonly isBoundOrbit: boolean;
  readonly isOrbitAchieved: boolean;
  readonly apoapsisWorldPos: Vec3Like | null;
  readonly periapsisWorldPos: Vec3Like | null;
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/**
 * Computes central-body gravitational parameter mu = g0 * R_sim^2
 * so surface gravity matches exact NASA gravityMps2 at r = R_sim.
 */
export function computeGravitationalParameter(
  gravityMps2: number,
  simRadiusM: number
): number {
  return Math.max(0, gravityMps2) * simRadiusM * simRadiusM;
}

/**
 * Computes classical 2-body Keplerian orbital elements around planet center (0, -simRadiusM, 0).
 */
export function computeOrbitalElements(
  worldPos: Vec3Like,
  worldVel: Vec3Like,
  simRadiusM: number,
  gravityMps2: number,
  atmosphereTopM: number
): OrbitalElements {
  const mu = computeGravitationalParameter(gravityMps2, simRadiusM);

  const rx = worldPos.x;
  const ry = worldPos.y + simRadiusM;
  const rz = worldPos.z;
  const rMag = Math.max(1, Math.hypot(rx, ry, rz));
  const invR = 1 / rMag;
  const rHatX = rx * invR;
  const rHatY = ry * invR;
  const rHatZ = rz * invR;

  const vx = worldVel.x;
  const vy = worldVel.y;
  const vz = worldVel.z;
  const vSq = vx * vx + vy * vy + vz * vz;
  const vMag = Math.sqrt(vSq);

  const radialSpeedMps = vx * rHatX + vy * rHatY + vz * rHatZ;
  const tangentialSpeedMps = Math.sqrt(Math.max(0, vSq - radialSpeedMps * radialSpeedMps));
  const circularVelocityMps = Math.sqrt(mu * invR);

  const altitudeM = rMag - simRadiusM;
  const specificEnergy = 0.5 * vSq - mu * invR;

  // Specific angular momentum h = r x v
  const hx = ry * vz - rz * vy;
  const hy = rz * vx - rx * vz;
  const hz = rx * vy - ry * vx;
  const hSq = hx * hx + hy * hy + hz * hz;

  // Eccentricity vector e = (v x h) / mu - r / |r|
  let ex = 0;
  let ey = 0;
  let ez = 0;
  if (mu > 1e-6) {
    const vxhX = vy * hz - vz * hy;
    const vxhY = vz * hx - vx * hz;
    const vxhZ = vx * hy - vy * hx;
    ex = vxhX / mu - rHatX;
    ey = vxhY / mu - rHatY;
    ez = vxhZ / mu - rHatZ;
  }
  const eccentricity = Math.hypot(ex, ey, ez);

  const semiMajorAxisM =
    Math.abs(specificEnergy) > 1e-6 && mu > 1e-6 ? -mu / (2 * specificEnergy) : Infinity;

  const isBoundOrbit =
    specificEnergy < -1e-6 &&
    Number.isFinite(semiMajorAxisM) &&
    semiMajorAxisM > 0 &&
    eccentricity < 0.999999;

  const semiLatusRectum = mu > 1e-6 ? hSq / mu : 0;

  let apoapsisRadiusM = Infinity;
  let periapsisRadiusM = semiLatusRectum / (1 + eccentricity);
  if (isBoundOrbit) {
    apoapsisRadiusM = semiMajorAxisM * (1 + eccentricity);
    periapsisRadiusM = semiMajorAxisM * (1 - eccentricity);
  }

  const apoapsisAltM = Number.isFinite(apoapsisRadiusM)
    ? apoapsisRadiusM - simRadiusM
    : Infinity;
  const periapsisAltM = periapsisRadiusM - simRadiusM;

  let orbitalPeriodS: number | null = null;
  let timeToApoapsisS: number | null = null;
  let apoapsisWorldPos: Vec3Like | null = null;
  let periapsisWorldPos: Vec3Like | null = null;

  if (isBoundOrbit && mu > 1e-6) {
    const meanMotion = Math.sqrt(mu / (semiMajorAxisM * semiMajorAxisM * semiMajorAxisM));
    orbitalPeriodS = (2 * Math.PI) / meanMotion;

    if (eccentricity < 1e-5) {
      timeToApoapsisS = 0;
      apoapsisWorldPos = {
        x: -rHatX * apoapsisRadiusM,
        y: -simRadiusM - rHatY * apoapsisRadiusM,
        z: -rHatZ * apoapsisRadiusM,
      };
      periapsisWorldPos = {
        x: rHatX * periapsisRadiusM,
        y: -simRadiusM + rHatY * periapsisRadiusM,
        z: rHatZ * periapsisRadiusM,
      };
    } else {
      const rDotV = rx * vx + ry * vy + rz * vz;
      const cosE = clamp((semiMajorAxisM - rMag) / (semiMajorAxisM * eccentricity), -1, 1);
      const sinE = clamp(rDotV / (Math.sqrt(mu * semiMajorAxisM) * eccentricity), -1, 1);
      let E = Math.atan2(sinE, cosE);
      if (E < 0) {
        E += Math.PI * 2;
      }
      const M = E - eccentricity * Math.sin(E);
      const dM = M <= Math.PI ? Math.PI - M : 3 * Math.PI - M;
      timeToApoapsisS = dM / meanMotion;

      const invE = 1 / eccentricity;
      const eHatX = ex * invE;
      const eHatY = ey * invE;
      const eHatZ = ez * invE;

      periapsisWorldPos = {
        x: eHatX * periapsisRadiusM,
        y: -simRadiusM + eHatY * periapsisRadiusM,
        z: eHatZ * periapsisRadiusM,
      };
      apoapsisWorldPos = {
        x: -eHatX * apoapsisRadiusM,
        y: -simRadiusM - eHatY * apoapsisRadiusM,
        z: -eHatZ * apoapsisRadiusM,
      };
    }
  }

  const minSafePeriapsisAlt =
    atmosphereTopM > 0 ? Math.max(atmosphereTopM * 1.15, 100_000) : 40_000;
  const isOrbitAchieved =
    isBoundOrbit &&
    periapsisAltM >= minSafePeriapsisAlt &&
    eccentricity < 0.25 &&
    altitudeM > 0;

  return {
    mu,
    radiusM: rMag,
    altitudeM,
    orbitalSpeedMps: vMag,
    radialSpeedMps,
    tangentialSpeedMps,
    circularVelocityMps,
    specificEnergy,
    semiMajorAxisM,
    eccentricity,
    apoapsisRadiusM,
    periapsisRadiusM,
    apoapsisAltM,
    periapsisAltM,
    orbitalPeriodS,
    timeToApoapsisS,
    isBoundOrbit,
    isOrbitAchieved,
    apoapsisWorldPos,
    periapsisWorldPos,
  };
}

/**
 * Samples world-space 3D conic trajectory points around planet center (0, -simRadiusM, 0).
 * Forms a closed ellipse when bound above surface, or a forward arc ending cleanly at impact.
 */
export function sampleOrbitPoints(
  worldPos: Vec3Like,
  worldVel: Vec3Like,
  simRadiusM: number,
  mu: number,
  numSamples = 160
): Vec3Like[] {
  const rx = worldPos.x;
  const ry = worldPos.y + simRadiusM;
  const rz = worldPos.z;
  const rMag = Math.max(1, Math.hypot(rx, ry, rz));

  if (mu <= 1e-6 || numSamples < 4) {
    return [worldPos];
  }

  const vx = worldVel.x;
  const vy = worldVel.y;
  const vz = worldVel.z;
  const hx = ry * vz - rz * vy;
  const hy = rz * vx - rx * vz;
  const hz = rx * vy - ry * vx;
  const hMag = Math.hypot(hx, hy, hz);
  const minAngularMomentum = 0.002 * simRadiusM * Math.sqrt(mu / simRadiusM);

  // Near-vertical flight off pad: integrate short forward ballistic preview
  if (hMag < minAngularMomentum) {
    const pts: Vec3Like[] = [];
    let px = rx;
    let py = ry;
    let pz = rz;
    let pvx = vx;
    let pvy = vy;
    let pvz = vz;
    const stepDt = clamp(simRadiusM / 400_000, 1.5, 16.0);
    const maxSteps = Math.min(80, numSamples);
    for (let i = 0; i <= maxSteps; i++) {
      const rm = Math.hypot(px, py, pz);
      if (i > 0 && rm < simRadiusM) {
        const s = simRadiusM / Math.max(1, rm);
        pts.push({ x: px * s, y: py * s - simRadiusM, z: pz * s });
        break;
      }
      pts.push({ x: px, y: py - simRadiusM, z: pz });
      const invR3 = -mu / (rm * rm * rm);
      pvx += px * invR3 * stepDt;
      pvy += py * invR3 * stepDt;
      pvz += pz * invR3 * stepDt;
      px += pvx * stepDt;
      py += pvy * stepDt;
      pz += pvz * stepDt;
    }
    return pts;
  }

  const invR = 1 / rMag;
  const vxhX = vy * hz - vz * hy;
  const vxhY = vz * hx - vx * hz;
  const vxhZ = vx * hy - vy * hx;
  const ex = vxhX / mu - rx * invR;
  const ey = vxhY / mu - ry * invR;
  const ez = vxhZ / mu - rz * invR;
  const e = Math.hypot(ex, ey, ez);

  const hHat = { x: hx / hMag, y: hy / hMag, z: hz / hMag };
  const rawP =
    e > 1e-4
      ? { x: ex / e, y: ey / e, z: ez / e }
      : { x: rx * invR, y: ry * invR, z: rz * invR };
  // Orthogonalize pHat cleanly against hHat so near-circular orbits have zero basis drift
  const pDotH = rawP.x * hHat.x + rawP.y * hHat.y + rawP.z * hHat.z;
  const pOx = rawP.x - pDotH * hHat.x;
  const pOy = rawP.y - pDotH * hHat.y;
  const pOz = rawP.z - pDotH * hHat.z;
  const pOLen = Math.max(1e-9, Math.hypot(pOx, pOy, pOz));
  const pHat = { x: pOx / pOLen, y: pOy / pOLen, z: pOz / pOLen };

  const qRawX = hHat.y * pHat.z - hHat.z * pHat.y;
  const qRawY = hHat.z * pHat.x - hHat.x * pHat.z;
  const qRawZ = hHat.x * pHat.y - hHat.y * pHat.x;
  const qLen = Math.max(1e-9, Math.hypot(qRawX, qRawY, qRawZ));
  const qHat = { x: qRawX / qLen, y: qRawY / qLen, z: qRawZ / qLen };

  const p = (hMag * hMag) / mu;
  const vSq = vx * vx + vy * vy + vz * vz;
  const energy = 0.5 * vSq - mu * invR;
  const isBound = energy < -1e-6 && e < 0.999999;
  const periapsisR = p / (1 + e);

  const pointAtNu = (nu: number): Vec3Like => {
    const cosN = Math.cos(nu);
    const sinN = Math.sin(nu);
    const denom = Math.max(0.05, 1 + e * cosN);
    const rad = Math.max(simRadiusM * 0.999, p / denom);
    return {
      x: rad * (cosN * pHat.x + sinN * qHat.x),
      y: rad * (cosN * pHat.y + sinN * qHat.y) - simRadiusM,
      z: rad * (cosN * pHat.z + sinN * qHat.z),
    };
  };

  // Closed bound orbit entirely above surface: guaranteed seamless loop with zero V-spike
  if (isBound && periapsisR > simRadiusM) {
    const pts: Vec3Like[] = [];
    for (let i = 0; i < numSamples; i++) {
      const nu = (i / numSamples) * Math.PI * 2;
      pts.push(pointAtNu(nu));
    }
    if (pts.length > 0) {
      pts.push({ x: pts[0].x, y: pts[0].y, z: pts[0].z });
    }
    return pts;
  }

  let nu0 = Math.atan2(rx * qHat.x + ry * qHat.y + rz * qHat.z, rx * pHat.x + ry * pHat.y + rz * pHat.z);
  if (isBound) {
    if (nu0 < 0) nu0 += Math.PI * 2;
    const cosImp = clamp((p / simRadiusM - 1) / Math.max(e, 1e-6), -1, 1);
    const nuImpMag = Math.acos(cosImp);
    const nuEnd = Math.PI * 2 - nuImpMag;
    // If spacecraft is already past impact true anomaly (descending right at surface), stop cleanly without wrapping through periapsis
    if (nuEnd <= nu0 + 1e-4) {
      const radEnd = Math.max(simRadiusM, rMag);
      const scale = simRadiusM / radEnd;
      return [
        { x: worldPos.x, y: worldPos.y, z: worldPos.z },
        { x: rx * scale, y: ry * scale - simRadiusM, z: rz * scale },
      ];
    }
    const pts: Vec3Like[] = [];
    for (let i = 0; i <= numSamples; i++) {
      const nu = nu0 + (i / numSamples) * (nuEnd - nu0);
      pts.push(pointAtNu(nu));
    }
    return pts;
  }

  // Hyperbolic / escape arc
  const asymptote = e > 1.0001 ? Math.acos(-1 / e) - 0.06 : Math.PI - 0.12;
  const maxR = simRadiusM * 4.0;
  const maxRCos = clamp((p / maxR - 1) / Math.max(e, 1e-6), -1, 1);
  const maxRNu = Math.acos(maxRCos);
  const nuEnd = Math.max(nu0 + 0.05, Math.min(asymptote, maxRNu));
  const pts: Vec3Like[] = [];
  for (let i = 0; i <= numSamples; i++) {
    const nu = nu0 + (i / numSamples) * (nuEnd - nu0);
    const cosN = Math.cos(nu);
    const rad = p / Math.max(0.05, 1 + e * cosN);
    if (i > 0 && rad < simRadiusM) {
      pts.push(pointAtNu(nu));
      break;
    }
    pts.push({
      x: rad * (cosN * pHat.x + Math.sin(nu) * qHat.x),
      y: rad * (cosN * pHat.y + Math.sin(nu) * qHat.y) - simRadiusM,
      z: rad * (cosN * pHat.z + Math.sin(nu) * qHat.z),
    });
  }
  return pts;
}
