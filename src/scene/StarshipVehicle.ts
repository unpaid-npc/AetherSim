import * as THREE from "three";
import { DEFAULT_VEHICLE_ID, type PlumeStyle, type VehicleId, getVehicleConfig } from "../config/vehicles";
import {
  type BuiltVehicleAssembly,
  type NozzleSocketSpec,
  type SideBoosterMountSpec,
  buildRocketFleetAssembly,
} from "./RocketFleetBuilder";

export interface NozzleTransform {
  position: THREE.Vector3;
  direction: THREE.Vector3;
  radius: number;
  throttle: number;
  kind: "booster" | "ship_sl" | "ship_vac";
}

/**
 * Procedural 1:1 scale 3D Rocket Fleet Wrapper supporting Starship+Super Heavy,
 * Falcon 9 Block 5, ISRO LVM3 (with S200 strap-on separation), and NASA Saturn V.
 */
export class StarshipVehicle {
  public readonly root = new THREE.Group();
  public readonly detachedBoosterRoot = new THREE.Group();
  public readonly detachedLeftSideRoot = new THREE.Group();
  public readonly detachedRightSideRoot = new THREE.Group();

  private readonly boosterGroup = new THREE.Group();
  private readonly shipGroup = new THREE.Group();
  private readonly leftSideGroup = new THREE.Group();
  private readonly rightSideGroup = new THREE.Group();

  private readonly boosterGimbalGroup = new THREE.Group();
  private readonly shipGimbalGroup = new THREE.Group();

  private assembly!: BuiltVehicleAssembly;
  private vehicleId: VehicleId = DEFAULT_VEHICLE_ID;
  private readonly maxAnisotropy: number;

  private mode: "launch" | "landing" = "launch";
  private separated = false;
  private sideSeparated = false;
  private boosterThrottle = 0;
  private detachedBoosterThrottle = 0;
  private shipThrottle = 0;
  private sideBoosterThrottle = 0;

  constructor(maxAnisotropy: number, initialVehicleId: VehicleId = DEFAULT_VEHICLE_ID) {
    this.maxAnisotropy = maxAnisotropy;
    this.root.rotation.order = "YXZ";
    this.detachedBoosterRoot.rotation.order = "YXZ";
    this.detachedLeftSideRoot.rotation.order = "YXZ";
    this.detachedRightSideRoot.rotation.order = "YXZ";
    this.detachedBoosterRoot.visible = false;
    this.detachedLeftSideRoot.visible = false;
    this.detachedRightSideRoot.visible = false;

    this.root.add(this.boosterGroup, this.shipGroup, this.leftSideGroup, this.rightSideGroup);
    this.setVehicle(initialVehicleId, "launch");
  }

  getVehicleId(): VehicleId {
    return this.vehicleId;
  }

  setVehicle(vehicleId: VehicleId, mode: "launch" | "landing" = this.mode): void {
    this.clearAssembly();
    this.vehicleId = vehicleId;
    this.assembly = buildRocketFleetAssembly(
      vehicleId,
      this.maxAnisotropy,
      this.boosterGroup,
      this.shipGroup,
      this.leftSideGroup,
      this.rightSideGroup,
      this.boosterGimbalGroup,
      this.shipGimbalGroup
    );
    this.configureMode(mode);
  }

  private clearAssembly(): void {
    if (this.assembly) {
      this.boosterGroup.remove(this.assembly.boosterPlumeLight);
      this.shipGroup.remove(this.assembly.shipPlumeLight);
      for (const item of this.assembly.disposables) {
        item.dispose();
      }
    }
    this.boosterGimbalGroup.clear();
    this.shipGimbalGroup.clear();
    this.boosterGroup.clear();
    this.shipGroup.clear();
    this.leftSideGroup.clear();
    this.rightSideGroup.clear();
  }

  getPlumeSocketSpec(): {
    boosterSockets: readonly NozzleSocketSpec[];
    shipSockets: readonly NozzleSocketSpec[];
    sideMounts: readonly SideBoosterMountSpec[];
    boosterPlumeStyle: PlumeStyle;
    shipPlumeStyle: PlumeStyle;
    sidePlumeStyle: PlumeStyle;
  } {
    return {
      boosterSockets: this.assembly.boosterLocalNozzles,
      shipSockets: this.assembly.shipLocalNozzles,
      sideMounts: this.assembly.sideBoosterMounts,
      boosterPlumeStyle: this.assembly.boosterPlumeStyle,
      shipPlumeStyle: this.assembly.shipPlumeStyle,
      sidePlumeStyle: this.assembly.sidePlumeStyle,
    };
  }

  getSideBoosterPlumeAnchors(): { left: THREE.Group; right: THREE.Group } {
    return { left: this.leftSideGroup, right: this.rightSideGroup };
  }

  configureMode(mode: "launch" | "landing"): void {
    const veh = getVehicleConfig(this.vehicleId);
    const safeMode = mode === "landing" && !veh.supportsLandingMode ? "launch" : mode;
    this.mode = safeMode;
    this.separated = false;
    this.sideSeparated = !veh.hasSideBoosters;
    this.detachedBoosterRoot.visible = false;
    this.detachedLeftSideRoot.visible = false;
    this.detachedRightSideRoot.visible = false;

    if (safeMode === "launch") {
      if (this.boosterGroup.parent !== this.root) {
        this.root.add(this.boosterGroup);
      }
      if (veh.hasSideBoosters) {
        this.root.add(this.leftSideGroup, this.rightSideGroup);
        const [leftMount, rightMount] = this.assembly.sideBoosterMounts;
        if (leftMount) {
          this.leftSideGroup.visible = true;
          this.leftSideGroup.position.copy(leftMount.localPos);
          this.leftSideGroup.rotation.set(0, 0, 0);
        }
        if (rightMount) {
          this.rightSideGroup.visible = true;
          this.rightSideGroup.position.copy(rightMount.localPos);
          this.rightSideGroup.rotation.set(0, 0, 0);
        }
      } else {
        this.leftSideGroup.visible = false;
        this.rightSideGroup.visible = false;
      }

      this.boosterGroup.visible = true;
      this.boosterGroup.position.set(0, 0, 0);
      this.boosterGroup.rotation.set(0, 0, 0);

      this.shipGroup.visible = true;
      this.shipGroup.position.set(0, veh.stage1HeightM, 0);
      this.setLandingLegsDeployed(0.0);
      this.setBoosterLandingLegsDeployed(0.0);
    } else {
      this.boosterGroup.visible = false;
      this.leftSideGroup.visible = false;
      this.rightSideGroup.visible = false;
      this.shipGroup.visible = true;
      this.shipGroup.position.set(0, 0, 0);
    }
  }

  resetStack(mode: "launch" | "landing"): void {
    this.configureMode(mode);
    this.setFrostLevel(mode === "launch" ? 1.0 : 0.25);
    this.setFlapAngle(mode === "launch" ? 0.05 : 0.85);
    this.setGridFinDeflection(0, 0);
    this.setEngineVisualState(0, 0, 0, 0, 0, 0);
  }

  triggerSideBoosterSeparation(
    leftPos: THREE.Vector3,
    rightPos: THREE.Vector3,
    pitch: number,
    yaw: number,
    roll: number
  ): void {
    if (this.sideSeparated || this.mode !== "launch") {
      return;
    }
    this.sideSeparated = true;
    this.detachedLeftSideRoot.add(this.leftSideGroup);
    this.detachedRightSideRoot.add(this.rightSideGroup);
    this.leftSideGroup.position.set(0, 0, 0);
    this.rightSideGroup.position.set(0, 0, 0);
    this.detachedLeftSideRoot.visible = true;
    this.detachedRightSideRoot.visible = true;
    this.detachedLeftSideRoot.position.copy(leftPos);
    this.detachedRightSideRoot.position.copy(rightPos);
    this.detachedLeftSideRoot.rotation.set(roll, yaw, -pitch);
    this.detachedRightSideRoot.rotation.set(roll, yaw, -pitch);
  }

  triggerStageSeparation(
    worldPos: THREE.Vector3,
    pitch: number,
    yaw: number,
    roll: number
  ): void {
    if (this.separated || this.mode !== "launch") {
      return;
    }
    this.separated = true;
    this.detachedBoosterRoot.add(this.boosterGroup);
    this.detachedBoosterRoot.visible = true;
    this.detachedBoosterRoot.position.copy(worldPos);
    this.detachedBoosterRoot.rotation.set(roll, yaw, -pitch);
    this.shipGroup.position.set(0, 0, 0);
  }

  setFrostLevel(level: number): void {
    const clamped = Math.max(0, Math.min(1, level));
    if (this.assembly.boosterFrostMat) {
      this.assembly.boosterFrostMat.opacity = clamped * 0.86;
    }
    if (this.assembly.shipFrostMat) {
      this.assembly.shipFrostMat.opacity = clamped * 0.82;
    }
  }

  setFlapAngle(angleRad: number): void {
    const a = Math.max(-0.2, Math.min(1.35, angleRad));
    for (const item of this.assembly.forwardFlapPivots) {
      item.pivot.rotation.y = item.side * a * 0.72;
    }
    for (const item of this.assembly.aftFlapPivots) {
      item.pivot.rotation.y = item.side * a * 0.85;
    }
  }

  setGridFinDeflection(pitch: number, yaw: number): void {
    for (const item of this.assembly.gridFinPivots) {
      const cmd = item.axis === "x" ? pitch : yaw;
      item.pivot.rotation.z = item.sign * cmd * 0.65;
    }
  }

  setLandingLegsDeployed(deploy: number): void {
    const d = Math.max(0, Math.min(1, deploy));
    const swingAngle = d * 0.78;
    for (const leg of this.assembly.shipLegAssemblies) {
      leg.pivot.rotation.z = swingAngle;
      leg.footPivot.rotation.z = -swingAngle;
    }
  }

  setBoosterLandingLegsDeployed(deploy: number): void {
    const d = Math.max(0, Math.min(1, deploy));
    const swingAngle = -d * 1.92;
    for (const leg of this.assembly.boosterLegAssemblies) {
      leg.pivot.rotation.z = swingAngle;
      leg.footPivot.rotation.z = -swingAngle * 0.5;
    }
  }

  setIntactVisible(visible: boolean): void {
    this.root.visible = visible;
    if (!visible) {
      if (!this.separated) {
        this.assembly.boosterPlumeLight.intensity = 0;
      }
      this.assembly.shipPlumeLight.intensity = 0;
    }
  }

  setBoosterIntactVisible(visible: boolean): void {
    if (!this.separated) {
      return;
    }
    this.detachedBoosterRoot.visible = visible;
    if (!visible) {
      this.assembly.boosterPlumeLight.intensity = 0;
    }
  }

  getBoosterPlumeAnchor(): THREE.Group {
    return this.boosterGroup;
  }

  getShipPlumeAnchor(): THREE.Group {
    return this.shipGimbalGroup;
  }

  getRcsAnchorGroup(): THREE.Group {
    return this.shipGroup;
  }

  getShipGroup(): THREE.Group {
    return this.shipGroup;
  }

  getBoosterGroup(): THREE.Group {
    return this.boosterGroup;
  }

  setEngineVisualState(
    boosterThrottle: number,
    shipThrottle: number,
    gimbalX: number,
    gimbalZ: number,
    detachedBoosterThrottle = 0,
    sideBoosterThrottle = 0
  ): void {
    this.boosterThrottle = Math.max(0, Math.min(1, boosterThrottle));
    this.detachedBoosterThrottle = Math.max(0, Math.min(1, detachedBoosterThrottle));
    this.shipThrottle = Math.max(0, Math.min(1, shipThrottle));
    this.sideBoosterThrottle = Math.max(0, Math.min(1, sideBoosterThrottle));

    this.boosterGimbalGroup.rotation.set(gimbalZ * 0.55, 0, -gimbalX * 0.55);
    this.shipGimbalGroup.rotation.set(gimbalZ * 0.65, 0, -gimbalX * 0.65);

    const activeBThr = Math.max(
      this.separated ? this.detachedBoosterThrottle : this.boosterThrottle,
      !this.sideSeparated ? this.sideBoosterThrottle : 0
    );
    const boosterVisible = this.separated
      ? this.detachedBoosterRoot.visible && this.boosterGroup.visible
      : this.root.visible && this.boosterGroup.visible;
    this.assembly.boosterPlumeLight.intensity =
      activeBThr > 0.02 && boosterVisible ? 14.0 + activeBThr * 32.0 : 0;

    const sVis = this.shipThrottle > 0.02 && this.shipGroup.visible;
    this.assembly.shipPlumeLight.intensity = sVis ? 10.0 + this.shipThrottle * 24.0 : 0;
  }

  /** Returns active nozzle world transforms ready for shader exhaust plumes. */
  getActiveNozzleTransforms(): NozzleTransform[] {
    const out: NozzleTransform[] = [];
    this.root.updateMatrixWorld(true);
    this.detachedBoosterRoot.updateMatrixWorld(true);
    const downDir = new THREE.Vector3(0, -1, 0);

    const activeBThr = this.separated ? this.detachedBoosterThrottle : this.boosterThrottle;
    const boosterVisible = this.separated
      ? this.detachedBoosterRoot.visible && this.boosterGroup.visible
      : this.root.visible && this.boosterGroup.visible;

    if (activeBThr > 0.02 && boosterVisible) {
      const quat = new THREE.Quaternion();
      this.boosterGroup.getWorldQuaternion(quat);
      const dir = downDir.clone().applyQuaternion(quat).normalize();
      for (const n of this.assembly.boosterLocalNozzles) {
        const worldPos = n.pos.clone();
        this.boosterGroup.localToWorld(worldPos);
        out.push({
          position: worldPos,
          direction: dir.clone(),
          radius: n.radius,
          throttle: activeBThr,
          kind: "booster",
        });
      }
    }

    if (this.shipThrottle > 0.02 && this.shipGroup.visible) {
      const quat = new THREE.Quaternion();
      this.shipGroup.getWorldQuaternion(quat);
      const dir = downDir.clone().applyQuaternion(quat).normalize();
      for (const n of this.assembly.shipLocalNozzles) {
        const worldPos = n.pos.clone();
        this.shipGroup.localToWorld(worldPos);
        out.push({
          position: worldPos,
          direction: dir.clone(),
          radius: n.radius,
          throttle: this.shipThrottle,
          kind: n.kind,
        });
      }
    }

    return out;
  }

  getActiveNozzleWorldPositions(): THREE.Vector3[] {
    return this.getActiveNozzleTransforms().map((n) => n.position);
  }

  dispose(): void {
    this.clearAssembly();
  }
}
