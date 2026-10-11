import {
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  computed,
  effect,
  inject,
} from '@angular/core';
import * as THREE from 'three';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Agent, AgentStatus, formatTokens, totalTokens } from '../models/agent.model';
import { AgentService } from '../services/agent';

interface AgentVisual {
  group: THREE.Group;
  mesh: THREE.Mesh;
  ring: THREE.Mesh;
  label: CSS2DObject;
  status: AgentStatus;
  seed: number;
  /** Grows slowly with token spend so heavy agents read bigger at a glance. */
  sizeFactor: number;
}

const STATUS_COLOR: Record<AgentStatus, number> = {
  idle: 0x64748b,
  working: 0xf59e0b,
  done: 0x22c55e,
};

@Component({
  imports: [],
  selector: 'app-monitor',
  styleUrl: './monitor.css',
  templateUrl: './monitor.html',
})
export class Monitor implements OnDestroy {
  @ViewChild('host', { static: true }) hostRef!: ElementRef<HTMLDivElement>;

  private readonly agentService = inject(AgentService);

  private renderer?: THREE.WebGLRenderer;
  private labelRenderer?: CSS2DRenderer;
  private scene?: THREE.Scene;
  private camera?: THREE.PerspectiveCamera;
  private controls?: OrbitControls;
  private resizeObserver?: ResizeObserver;
  private frameHandle = 0;
  private readonly clock = new THREE.Clock();
  private readonly visuals = new Map<string, AgentVisual>();
  private readonly relationLines = new Map<string, THREE.Line>();
  // Decorative scene shown only while there are no agents, replaced by the real ones.
  private welcome?: THREE.Group;
  private readonly orbiters: {
    mesh: THREE.Mesh;
    radius: number;
    speed: number;
    tilt: number;
    phase: number;
  }[] = [];

  protected readonly empty = computed(() => this.agentService.agents().length === 0);
  private initialized = false;

  protected readonly totalTokens = computed(() =>
    formatTokens(this.agentService.totalTokenCount()),
  );
  protected readonly totalEstimated = computed(() => !!this.agentService.totalUsage().estimated);

  constructor() {
    effect(() => {
      const agents = this.agentService.agents();
      if (this.initialized) {
        this.syncVisuals(agents);
      }
    });
  }

  ngAfterViewInit(): void {
    try {
      this.setupScene();
    } catch (err) {
      console.warn('3D monitor unavailable: WebGL could not be initialized.', err);
      return;
    }
    this.initialized = true;
    this.syncVisuals(this.agentService.agents());
    this.animate();
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.frameHandle);
    this.resizeObserver?.disconnect();
    this.controls?.dispose();
    this.visuals.forEach((visual) => this.disposeVisual(visual));
    this.visuals.clear();
    this.relationLines.forEach((line) => this.disposeLine(line));
    this.relationLines.clear();
    if (this.welcome) this.disposeGroup(this.welcome);
    this.renderer?.dispose();
    this.labelRenderer?.domElement.remove();
  }

  private setupScene(): void {
    const host = this.hostRef.nativeElement;
    const width = host.clientWidth || 1;
    const height = host.clientHeight || 1;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b1120);
    this.scene.fog = new THREE.Fog(0x0b1120, 10, 26);

    this.camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 100);
    this.camera.position.set(0, 3.5, 9);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height);
    host.appendChild(this.renderer.domElement);

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.setSize(width, height);
    this.labelRenderer.domElement.style.position = 'absolute';
    this.labelRenderer.domElement.style.top = '0';
    this.labelRenderer.domElement.style.left = '0';
    this.labelRenderer.domElement.style.pointerEvents = 'none';
    host.appendChild(this.labelRenderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 18;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.target.set(0, 0.5, 0);

    const ambient = new THREE.AmbientLight(0x394867, 1.1);
    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(5, 8, 6);
    const rim = new THREE.PointLight(0x38bdf8, 0.6, 20);
    rim.position.set(-6, 4, -4);
    this.scene.add(ambient, key, rim);

    const grid = new THREE.GridHelper(20, 20, 0x1e293b, 0x111827);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.5;
    this.scene.add(grid);

    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(host);
  }

  private onResize(): void {
    if (!this.camera || !this.renderer || !this.labelRenderer) return;
    const host = this.hostRef.nativeElement;
    const width = host.clientWidth || 1;
    const height = host.clientHeight || 1;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.labelRenderer.setSize(width, height);
  }

  private syncVisuals(agents: Agent[]): void {
    if (!this.scene) return;

    const seen = new Set<string>();
    agents.forEach((agent, index) => {
      seen.add(agent.id);
      let visual = this.visuals.get(agent.id);
      if (!visual) {
        visual = this.createVisual(agent);
        this.visuals.set(agent.id, visual);
        this.scene!.add(visual.group);
      }
      visual.status = agent.status;

      const targetX = (index - (agents.length - 1) / 2) * 2.6;
      visual.group.userData['targetX'] = targetX;

      const color = new THREE.Color(STATUS_COLOR[agent.status]);
      const material = visual.mesh.material as THREE.MeshStandardMaterial;
      material.color.lerp(color, 1);
      material.emissive.set(color).multiplyScalar(agent.status === 'idle' ? 0.05 : 0.35);

      const ringMaterial = visual.ring.material as THREE.MeshBasicMaterial;
      ringMaterial.color.set(color);
      visual.ring.visible = agent.status !== 'idle';

      const label = visual.label.element as HTMLDivElement;
      const tokens = totalTokens(agent.usage);
      const estimate = agent.usage.estimated ? '~' : '';
      label.className = `agent-label label-${agent.status}`;
      label.replaceChildren(
        this.labelLine('agent-label-name', `${agent.name} · ${Math.round(agent.progress)}%`),
        this.labelLine('agent-label-tokens', `${estimate}${formatTokens(tokens)} tokens`),
      );
      visual.sizeFactor = 1 + Math.min(0.45, Math.log10(1 + tokens) * 0.07);
    });

    for (const [id, visual] of this.visuals) {
      if (!seen.has(id)) {
        this.scene.remove(visual.group);
        this.disposeVisual(visual);
        this.visuals.delete(id);
      }
    }

    this.syncRelationLines(agents);
    this.syncWelcome(agents.length === 0);
  }

  private syncWelcome(show: boolean): void {
    if (!this.scene) return;
    if (show && !this.welcome) {
      this.welcome = this.createWelcome();
      this.scene.add(this.welcome);
    } else if (!show && this.welcome) {
      this.scene.remove(this.welcome);
      this.disposeGroup(this.welcome);
      this.welcome = undefined;
      this.orbiters.length = 0;
    }
  }

  private createWelcome(): THREE.Group {
    const group = new THREE.Group();
    const accent = 0x38bdf8;

    const core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.55, 1),
      new THREE.MeshStandardMaterial({
        color: accent,
        emissive: accent,
        emissiveIntensity: 0.45,
        metalness: 0.2,
        roughness: 0.35,
      }),
    );
    core.name = 'core';
    core.position.y = 1.2;

    const shell = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.15, 2),
      new THREE.MeshBasicMaterial({
        color: accent,
        wireframe: true,
        transparent: true,
        opacity: 0.22,
      }),
    );
    shell.name = 'shell';
    shell.position.y = 1.2;

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.7, 1.78, 64),
      new THREE.MeshBasicMaterial({
        color: accent,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.35,
      }),
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.02;

    group.add(core, shell, ring);

    // Small spheres in the same colors as the agent states, orbiting the core.
    const states = [0x64748b, 0xf59e0b, 0x22c55e];
    states.forEach((color, i) => {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.17, 24, 24),
        new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.5 }),
      );
      group.add(mesh);
      this.orbiters.push({
        mesh,
        radius: 1.9 + i * 0.45,
        speed: 0.7 - i * 0.14,
        tilt: 0.35 + i * 0.3,
        phase: (i * Math.PI * 2) / 3,
      });
    });
    return group;
  }

  private disposeGroup(group: THREE.Group): void {
    group.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        (object.material as THREE.Material).dispose();
      }
    });
  }

  private syncRelationLines(agents: Agent[]): void {
    if (!this.scene) return;

    const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
    const desired = new Set<string>();
    agents.forEach((agent) => {
      agent.relatedIds.forEach((relId) => {
        if (this.visuals.has(relId)) {
          desired.add(pairKey(agent.id, relId));
        }
      });
    });

    for (const [key, line] of this.relationLines) {
      if (!desired.has(key)) {
        this.scene.remove(line);
        this.disposeLine(line);
        this.relationLines.delete(key);
      }
    }

    for (const key of desired) {
      if (!this.relationLines.has(key)) {
        const geometry = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(),
          new THREE.Vector3(),
        ]);
        const material = new THREE.LineBasicMaterial({
          color: 0x38bdf8,
          transparent: true,
          opacity: 0.45,
        });
        const line = new THREE.Line(geometry, material);
        this.relationLines.set(key, line);
        this.scene.add(line);
      }
    }
  }

  private labelLine(className: string, text: string): HTMLDivElement {
    const line = document.createElement('div');
    line.className = className;
    line.textContent = text;
    return line;
  }

  private createVisual(agent: Agent): AgentVisual {
    const group = new THREE.Group();

    const geometry = new THREE.IcosahedronGeometry(0.6, 1);
    const material = new THREE.MeshStandardMaterial({
      color: STATUS_COLOR[agent.status],
      emissive: 0x000000,
      metalness: 0.2,
      roughness: 0.35,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = 0.6;
    group.add(mesh);

    const ringGeometry = new THREE.RingGeometry(0.85, 1.0, 48);
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: STATUS_COLOR[agent.status],
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.6,
    });
    const ring = new THREE.Mesh(ringGeometry, ringMaterial);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.6;
    group.add(ring);

    const labelDiv = document.createElement('div');
    labelDiv.className = 'agent-label';
    const label = new CSS2DObject(labelDiv);
    label.position.set(0, 1.5, 0);
    group.add(label);

    return {
      group,
      mesh,
      ring,
      label,
      status: agent.status,
      seed: Math.random() * Math.PI * 2,
      sizeFactor: 1,
    };
  }

  private disposeVisual(visual: AgentVisual): void {
    visual.mesh.geometry.dispose();
    (visual.mesh.material as THREE.Material).dispose();
    visual.ring.geometry.dispose();
    (visual.ring.material as THREE.Material).dispose();
    visual.label.element.remove();
  }

  private disposeLine(line: THREE.Line): void {
    line.geometry.dispose();
    (line.material as THREE.Material).dispose();
  }

  private animateWelcome(elapsed: number): void {
    if (!this.welcome) return;
    const core = this.welcome.getObjectByName('core');
    const shell = this.welcome.getObjectByName('shell');
    if (core) {
      core.rotation.y = elapsed * 0.6;
      core.position.y = 1.2 + Math.sin(elapsed * 1.2) * 0.12;
      core.scale.setScalar(1 + Math.sin(elapsed * 2) * 0.04);
    }
    if (shell) {
      shell.rotation.y = -elapsed * 0.25;
      shell.rotation.x = elapsed * 0.1;
      shell.position.y = core?.position.y ?? 1.2;
    }
    for (const o of this.orbiters) {
      const angle = elapsed * o.speed + o.phase;
      o.mesh.position.set(
        Math.cos(angle) * o.radius,
        1.2 + Math.sin(angle) * o.radius * Math.sin(o.tilt),
        Math.sin(angle) * o.radius * Math.cos(o.tilt),
      );
    }
  }

  private animate = (): void => {
    this.frameHandle = requestAnimationFrame(this.animate);
    const elapsed = this.clock.getElapsedTime();

    this.animateWelcome(elapsed);

    this.visuals.forEach((visual) => {
      const targetX = (visual.group.userData['targetX'] as number) ?? visual.group.position.x;
      visual.group.position.x += (targetX - visual.group.position.x) * 0.08;

      const bob = Math.sin(elapsed * 1.4 + visual.seed) * 0.08;

      if (visual.status === 'idle') {
        visual.mesh.position.y = 0.6 + bob * 0.4;
        visual.mesh.rotation.y += 0.003;
        visual.mesh.scale.setScalar(visual.sizeFactor);
        visual.ring.rotation.z += 0.001;
      } else if (visual.status === 'working') {
        visual.mesh.position.y = 0.6 + bob;
        visual.mesh.rotation.y += 0.025;
        visual.mesh.rotation.x += 0.012;
        const pulse = 1 + Math.sin(elapsed * 5 + visual.seed) * 0.08;
        visual.mesh.scale.setScalar(pulse * visual.sizeFactor);
        visual.ring.rotation.z += 0.03;
        visual.ring.scale.setScalar(1 + Math.sin(elapsed * 5 + visual.seed) * 0.05);
      } else {
        visual.mesh.position.y = 0.6 + bob * 0.3;
        visual.mesh.rotation.y += 0.006;
        visual.mesh.scale.setScalar(1.08 * visual.sizeFactor);
        visual.ring.rotation.z += 0.006;
        visual.ring.scale.setScalar(1.15);
      }
    });

    this.relationLines.forEach((line, key) => {
      const [idA, idB] = key.split('|');
      const a = this.visuals.get(idA);
      const b = this.visuals.get(idB);
      if (!a || !b) return;
      const positions = line.geometry.getAttribute('position') as THREE.BufferAttribute;
      positions.setXYZ(0, a.group.position.x, a.mesh.position.y, a.group.position.z);
      positions.setXYZ(1, b.group.position.x, b.mesh.position.y, b.group.position.z);
      positions.needsUpdate = true;
    });

    this.controls?.update();
    if (this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera);
      this.labelRenderer?.render(this.scene, this.camera);
    }
  };
}
