"""Planetary environment presets, NASA reference metadata, and visual theme wrapper.

Provides ``moon``, ``mars``, ``earth``, and ``default`` presets for Gymnasium
``LunarLander-v3``. Physical surface gravities and pressures come from the NASA
Planetary Fact Sheet, whereas 2D Box2D ``wind_power`` and ``turbulence_power``
values are simplified simulation approximations rather than full aerodynamic or
CFD atmospheric models.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import gymnasium as gym
import numpy as np
from gymnasium.envs.box2d.lunar_lander import SCALE, VIEWPORT_H, VIEWPORT_W

ENV_ID = "LunarLander-v3"
PLANETARY_PRESETS = ("moon", "mars", "earth")
PLANET_CHOICES = ("default", "moon", "mars", "earth")

RgbColor = tuple[int, int, int]


@dataclass(frozen=True)
class PlanetTheme:
    """Visual palette and atmospheric/terrain styling options for rendering."""

    sky_top_rgb: RgbColor
    sky_mid_rgb: RgbColor
    sky_horizon_rgb: RgbColor
    terrain_fill_rgb: RgbColor
    terrain_subsurface_rgb: RgbColor
    terrain_ridge_rgb: RgbColor
    pad_rgb: RgbColor
    flag_pole_rgb: RgbColor
    flag_pennant_rgb: RgbColor
    lander_fill_rgb: RgbColor
    lander_outline_rgb: RgbColor
    accent_rgb: RgbColor
    has_stars: bool = False
    has_clouds: bool = False
    has_dust_haze: bool = False
    has_craters: bool = False
    visual_seed: int = 0


@dataclass(frozen=True)
class PlanetConfig:
    """Planetary physics configuration, reference constants, and visual theme.

    Note: ``wind_power`` and ``turbulence_power`` parameterize Gymnasium Box2D's
    simplified 2D lateral wind and rotational torque approximations and are not
    full aerodynamic or CFD models.
    """

    name: str
    display_name: str
    real_gravity_mps2: float
    real_surface_pressure_bar: float
    atmosphere_label: str
    gravity: float
    enable_wind: bool
    wind_power: float
    turbulence_power: float
    theme: PlanetTheme | None = None

    def env_kwargs(self) -> dict[str, Any]:
        """Return physics kwargs accepted by ``gym.make('LunarLander-v3', ...)``."""
        return {
            "gravity": self.gravity,
            "enable_wind": self.enable_wind,
            "wind_power": self.wind_power,
            "turbulence_power": self.turbulence_power,
        }

    def to_metadata_dict(self) -> dict[str, Any]:
        """Serialize physical reference and Box2D simulation fields for JSON/CSV logs."""
        return {
            "planet": self.name,
            "display_name": self.display_name,
            "real_gravity_mps2": self.real_gravity_mps2,
            "real_surface_pressure_bar": self.real_surface_pressure_bar,
            "atmosphere_label": self.atmosphere_label,
            "gravity": self.gravity,
            "enable_wind": self.enable_wind,
            "wind_power": self.wind_power,
            "turbulence_power": self.turbulence_power,
            "styled_theme": self.theme is not None,
        }


PLANETS: dict[str, PlanetConfig] = {
    "moon": PlanetConfig(
        name="moon",
        display_name="Moon",
        real_gravity_mps2=1.62,
        real_surface_pressure_bar=0.0,
        atmosphere_label="Vacuum (airless)",
        gravity=-1.62,
        enable_wind=False,
        wind_power=0.0,
        turbulence_power=0.0,
        theme=PlanetTheme(
            sky_top_rgb=(4, 6, 14),
            sky_mid_rgb=(8, 12, 22),
            sky_horizon_rgb=(14, 18, 30),
            terrain_fill_rgb=(122, 126, 134),
            terrain_subsurface_rgb=(86, 90, 98),
            terrain_ridge_rgb=(182, 186, 194),
            pad_rgb=(218, 222, 228),
            flag_pole_rgb=(245, 245, 245),
            flag_pennant_rgb=(250, 204, 21),
            lander_fill_rgb=(232, 236, 244),
            lander_outline_rgb=(24, 28, 38),
            accent_rgb=(148, 197, 255),
            has_stars=True,
            has_craters=True,
            visual_seed=101,
        ),
    ),
    "mars": PlanetConfig(
        name="mars",
        display_name="Mars",
        real_gravity_mps2=3.73,
        real_surface_pressure_bar=0.00636,
        atmosphere_label="Thin CO2 (~0.6% Earth)",
        gravity=-3.73,
        enable_wind=True,
        wind_power=5.0,
        turbulence_power=0.5,
        theme=PlanetTheme(
            sky_top_rgb=(112, 54, 34),
            sky_mid_rgb=(194, 118, 68),
            sky_horizon_rgb=(236, 168, 114),
            terrain_fill_rgb=(154, 66, 38),
            terrain_subsurface_rgb=(108, 42, 24),
            terrain_ridge_rgb=(208, 118, 72),
            pad_rgb=(220, 204, 182),
            flag_pole_rgb=(255, 248, 235),
            flag_pennant_rgb=(56, 189, 248),
            lander_fill_rgb=(245, 240, 232),
            lander_outline_rgb=(42, 18, 12),
            accent_rgb=(253, 186, 116),
            has_dust_haze=True,
            visual_seed=202,
        ),
    ),
    "earth": PlanetConfig(
        name="earth",
        display_name="Earth",
        real_gravity_mps2=9.81,
        real_surface_pressure_bar=1.014,
        atmosphere_label="Dense N2/O2 (1.01 bar)",
        gravity=-9.81,
        enable_wind=True,
        wind_power=15.0,
        turbulence_power=1.5,
        theme=PlanetTheme(
            sky_top_rgb=(38, 102, 186),
            sky_mid_rgb=(104, 170, 230),
            sky_horizon_rgb=(198, 226, 246),
            terrain_fill_rgb=(62, 92, 58),
            terrain_subsurface_rgb=(40, 58, 44),
            terrain_ridge_rgb=(98, 136, 82),
            pad_rgb=(208, 214, 220),
            flag_pole_rgb=(255, 255, 255),
            flag_pennant_rgb=(239, 68, 68),
            lander_fill_rgb=(244, 247, 250),
            lander_outline_rgb=(20, 32, 46),
            accent_rgb=(125, 211, 252),
            has_clouds=True,
            visual_seed=303,
        ),
    ),
    "default": PlanetConfig(
        name="default",
        display_name="Default (Canonical)",
        real_gravity_mps2=9.81,
        real_surface_pressure_bar=0.0,
        atmosphere_label="Canonical LunarLander-v3 (g=-10.0, no wind)",
        gravity=-10.0,
        enable_wind=False,
        wind_power=0.0,
        turbulence_power=0.0,
        theme=None,
    ),
}


def get_planet_config(planet_name: str) -> PlanetConfig:
    """Resolve a planet name (case-insensitive) to its ``PlanetConfig``."""
    key = planet_name.strip().lower()
    if key not in PLANETS:
        valid = ", ".join(PLANET_CHOICES)
        raise ValueError(f"Unknown planet {planet_name!r}. Expected one of: {valid}.")
    return PLANETS[key]


def _build_vertical_gradient(
    top: RgbColor, mid: RgbColor, horizon: RgbColor
) -> np.ndarray:
    """Build a (VIEWPORT_W, VIEWPORT_H, 3) uint8 gradient array for pygame.surfarray."""
    y_norm = np.linspace(0.0, 1.0, VIEWPORT_H, dtype=np.float32)
    split = 0.58
    t_upper = np.clip(y_norm / split, 0.0, 1.0)[:, None]
    t_lower = np.clip((y_norm - split) / (1.0 - split), 0.0, 1.0)[:, None]

    top_arr = np.asarray(top, dtype=np.float32)[None, :]
    mid_arr = np.asarray(mid, dtype=np.float32)[None, :]
    hor_arr = np.asarray(horizon, dtype=np.float32)[None, :]

    upper = top_arr * (1.0 - t_upper) + mid_arr * t_upper
    lower = mid_arr * (1.0 - t_lower) + hor_arr * t_lower
    col = np.where((y_norm <= split)[:, None], upper, lower)
    col_u8 = np.clip(np.rint(col), 0, 255).astype(np.uint8)
    # pygame.surfarray expects shape (width, height, 3)
    return np.broadcast_to(col_u8[None, :, :], (VIEWPORT_W, VIEWPORT_H, 3)).copy()


class PlanetaryVisualWrapper(gym.Wrapper):
    """Render wrapper applying planet-specific sky, terrain, and telemetry HUD.

    Preserves observations, rewards, termination/truncation flags, and spaces
    identically to the wrapped environment.
    """

    def __init__(self, env: gym.Env, planet_config: PlanetConfig) -> None:
        super().__init__(env)
        self.planet_config = planet_config
        self._last_obs: np.ndarray | None = None
        self._sky_surface: Any = None
        self._hud_font: Any = None
        self._font_initialized = False

    def reset(
        self, *, seed: int | None = None, options: dict[str, Any] | None = None
    ) -> tuple[np.ndarray, dict[str, Any]]:
        obs, info = self.env.reset(seed=seed, options=options)
        self._last_obs = np.asarray(obs, dtype=np.float32).copy()
        if self.render_mode == "human" and self.planet_config.theme is not None:
            self._blit_human_frame()
        return obs, info

    def step(
        self, action: Any
    ) -> tuple[np.ndarray, float, bool, bool, dict[str, Any]]:
        obs, reward, terminated, truncated, info = self.env.step(action)
        self._last_obs = np.asarray(obs, dtype=np.float32).copy()
        if self.render_mode == "human" and self.planet_config.theme is not None:
            self._blit_human_frame()
        return obs, float(reward), terminated, truncated, info

    def _get_sky_surface(self, pygame: Any, theme: PlanetTheme) -> Any:
        if self._sky_surface is not None:
            return self._sky_surface

        grad = _build_vertical_gradient(
            theme.sky_top_rgb, theme.sky_mid_rgb, theme.sky_horizon_rgb
        )
        sky = pygame.surfarray.make_surface(grad)
        rng = np.random.default_rng(theme.visual_seed)

        if theme.has_stars:
            for _ in range(110):
                sx = int(rng.integers(0, VIEWPORT_W))
                sy = int(rng.integers(0, int(VIEWPORT_H * 0.78)))
                brightness = int(rng.integers(150, 256))
                radius = 2 if rng.random() > 0.88 else 1
                pygame.draw.circle(
                    sky, (brightness, brightness, min(255, brightness + 10)), (sx, sy), radius
                )

        if theme.has_dust_haze:
            haze = pygame.Surface((VIEWPORT_W, VIEWPORT_H), pygame.SRCALPHA)
            for idx, y_top in enumerate(range(190, VIEWPORT_H, 26)):
                alpha = 18 + idx * 5
                pygame.draw.rect(
                    haze, (238, 168, 108, min(72, alpha)), (0, y_top, VIEWPORT_W, 30)
                )
            sky.blit(haze, (0, 0))

        if theme.has_clouds:
            cloud_layer = pygame.Surface((VIEWPORT_W, VIEWPORT_H), pygame.SRCALPHA)
            for _ in range(7):
                cx = int(rng.integers(30, VIEWPORT_W - 40))
                cy = int(rng.integers(38, 175))
                w = int(rng.integers(75, 140))
                h = int(rng.integers(20, 34))
                pygame.draw.ellipse(cloud_layer, (245, 250, 255, 58), (cx, cy, w, h))
                pygame.draw.ellipse(
                    cloud_layer,
                    (250, 252, 255, 50),
                    (cx + w // 5, cy - h // 3, int(w * 0.65), int(h * 0.9)),
                )
            haze = pygame.Surface((VIEWPORT_W, 90), pygame.SRCALPHA)
            haze.fill((220, 238, 252, 42))
            cloud_layer.blit(haze, (0, 230))
            sky.blit(cloud_layer, (0, 0))

        self._sky_surface = sky
        return sky

    def _get_hud_font(self, pygame: Any) -> Any:
        if self._font_initialized:
            return self._hud_font
        self._font_initialized = True
        try:
            pygame.font.init()
            self._hud_font = pygame.font.SysFont("consolas", 12)
        except Exception:
            try:
                self._hud_font = pygame.font.Font(None, 16)
            except Exception:
                self._hud_font = None
        return self._hud_font

    @staticmethod
    def _world_to_screen(x_world: float, y_world: float) -> tuple[float, float]:
        return (x_world * SCALE, VIEWPORT_H - y_world * SCALE)

    def _render_styled_surface(
        self, pygame: Any, *, advance_particles: bool
    ) -> Any:
        theme = self.planet_config.theme
        assert theme is not None
        unwrapped = self.env.unwrapped

        surf = pygame.Surface((VIEWPORT_W, VIEWPORT_H))
        surf.blit(self._get_sky_surface(pygame, theme), (0, 0))

        # Build terrain polygon along the bottom of the screen from sky_polys
        ridge_pts: list[tuple[float, float]] = []
        for idx, poly in enumerate(unwrapped.sky_polys):
            p1 = self._world_to_screen(float(poly[0][0]), float(poly[0][1]))
            p2 = self._world_to_screen(float(poly[1][0]), float(poly[1][1]))
            if idx == 0:
                ridge_pts.append(p1)
            ridge_pts.append(p2)

        if ridge_pts:
            ground_poly = ridge_pts + [
                (float(VIEWPORT_W), float(VIEWPORT_H)),
                (0.0, float(VIEWPORT_H)),
            ]
            pygame.draw.polygon(surf, theme.terrain_fill_rgb, ground_poly)

            sub_pts = [(px, min(float(VIEWPORT_H), py + 24.0)) for px, py in ridge_pts]
            sub_poly = sub_pts + [
                (float(VIEWPORT_W), float(VIEWPORT_H)),
                (0.0, float(VIEWPORT_H)),
            ]
            pygame.draw.polygon(surf, theme.terrain_subsurface_rgb, sub_poly)

            if theme.has_craters:
                rng = np.random.default_rng(theme.visual_seed + 7)
                for _ in range(9):
                    cx = int(rng.integers(25, VIEWPORT_W - 25))
                    cy = int(rng.integers(VIEWPORT_H - 72, VIEWPORT_H - 12))
                    rx = int(rng.integers(10, 22))
                    ry = max(4, rx // 3)
                    pygame.draw.ellipse(
                        surf, (66, 70, 78), (cx - rx, cy - ry, rx * 2, ry * 2)
                    )
                    pygame.draw.ellipse(
                        surf,
                        (154, 158, 166),
                        (cx - rx, cy - ry, rx * 2, ry * 2),
                        width=1,
                    )

            pygame.draw.lines(surf, theme.terrain_ridge_rgb, False, ridge_pts, width=2)

        # Landing pad marker strip between helipad_x1 and helipad_x2
        pad_x1, pad_y = self._world_to_screen(
            float(unwrapped.helipad_x1), float(unwrapped.helipad_y)
        )
        pad_x2, _ = self._world_to_screen(
            float(unwrapped.helipad_x2), float(unwrapped.helipad_y)
        )
        pygame.draw.line(
            surf, theme.pad_rgb, (pad_x1, pad_y), (pad_x2, pad_y), width=4
        )

        # Landing flags
        for flag_world_x in (float(unwrapped.helipad_x1), float(unwrapped.helipad_x2)):
            fx, fy_bot = self._world_to_screen(flag_world_x, float(unwrapped.helipad_y))
            fy_top = fy_bot - 50.0
            pygame.draw.line(
                surf, theme.flag_pole_rgb, (fx, fy_bot), (fx, fy_top), width=2
            )
            pennant = [
                (fx, fy_top),
                (fx, fy_top + 11.0),
                (fx + 24.0, fy_top + 5.5),
            ]
            pygame.draw.polygon(surf, theme.flag_pennant_rgb, pennant)
            pygame.draw.polygon(surf, theme.lander_outline_rgb, pennant, width=1)

        # Exhaust particles (decorative only)
        if advance_particles:
            for obj in unwrapped.particles:
                obj.ttl -= 0.15
            unwrapped._clean_particles(False)

        for obj in unwrapped.particles:
            for f in obj.fixtures:
                center = self._world_to_screen(
                    float((f.body.transform * f.shape.pos)[0]),
                    float((f.body.transform * f.shape.pos)[1]),
                )
                ttl_ratio = max(0.0, min(1.0, float(obj.ttl)))
                p_col = (
                    255,
                    int(110 + 130 * ttl_ratio),
                    int(35 + 110 * ttl_ratio),
                )
                pygame.draw.circle(
                    surf,
                    p_col,
                    (int(center[0]), int(center[1])),
                    max(2, int(f.shape.radius * SCALE)),
                )

        # Lander body and legs
        for obj in unwrapped.drawlist:
            for f in obj.fixtures:
                trans = f.body.transform
                pts = [
                    self._world_to_screen(float((trans * v)[0]), float((trans * v)[1]))
                    for v in f.shape.vertices
                ]
                pygame.draw.polygon(surf, theme.lander_fill_rgb, pts)
                pygame.draw.polygon(surf, theme.lander_outline_rgb, pts, width=2)

        self._draw_hud(pygame, surf, theme)
        return surf

    def _draw_hud(self, pygame: Any, surf: Any, theme: PlanetTheme) -> None:
        hud_w, hud_h = 372, 44
        panel = pygame.Surface((hud_w, hud_h), pygame.SRCALPHA)
        panel.fill((8, 12, 20, 185))
        pygame.draw.rect(panel, (*theme.accent_rgb, 210), (0, 0, hud_w, hud_h), width=1)
        surf.blit(panel, (8, 8))

        font = self._get_hud_font(pygame)
        if font is None:
            return

        cfg = self.planet_config
        wind_txt = (
            f"wind={cfg.wind_power:.0f}/turb={cfg.turbulence_power:.1f}"
            if cfg.enable_wind
            else "vacuum"
        )
        line1 = f"{cfg.display_name.upper()} | g={cfg.real_gravity_mps2:.2f} m/s^2 | {wind_txt}"

        if self._last_obs is not None:
            vx = float(self._last_obs[2])
            vy = float(self._last_obs[3])
            tilt_deg = math.degrees(float(self._last_obs[4]))
            legs = ("L" if self._last_obs[6] > 0.5 else "-") + (
                "R" if self._last_obs[7] > 0.5 else "-"
            )
            line2 = f"vx={vx:+.2f} vy={vy:+.2f} tilt={tilt_deg:+.1f} deg legs={legs}"
        else:
            line2 = "vx=+0.00 vy=+0.00 tilt=+0.0 deg legs=--"

        surf.blit(font.render(line1, True, theme.accent_rgb), (15, 13))
        surf.blit(font.render(line2, True, (240, 244, 250)), (15, 30))

    def _blit_human_frame(self) -> None:
        import pygame

        unwrapped = self.env.unwrapped
        if unwrapped.screen is None:
            pygame.display.init()
            unwrapped.screen = pygame.display.set_mode((VIEWPORT_W, VIEWPORT_H))
        surf = self._render_styled_surface(pygame, advance_particles=False)
        unwrapped.screen.blit(surf, (0, 0))
        pygame.event.pump()
        pygame.display.flip()

    def render(self) -> Any:
        if self.planet_config.theme is None or self.render_mode is None:
            return super().render()

        import pygame

        if self.render_mode == "rgb_array":
            surf = self._render_styled_surface(pygame, advance_particles=True)
            arr = np.array(pygame.surfarray.pixels3d(surf), dtype=np.uint8)
            return np.transpose(arr, axes=(1, 0, 2))

        if self.render_mode == "human":
            self._blit_human_frame()
            return None

        return super().render()


def make_planet_env(
    planet: str = "default",
    *,
    render_mode: str | None = None,
    styled: bool = True,
    max_episode_steps: int | None = None,
) -> gym.Env:
    """Create a ``LunarLander-v3`` environment configured for the selected planet."""
    cfg = get_planet_config(planet)
    make_kwargs: dict[str, Any] = {}
    if render_mode is not None:
        make_kwargs["render_mode"] = render_mode
    if max_episode_steps is not None:
        make_kwargs["max_episode_steps"] = max_episode_steps

    if cfg.name == "default":
        return gym.make(ENV_ID, **make_kwargs)

    env = gym.make(ENV_ID, **cfg.env_kwargs(), **make_kwargs)
    if styled and render_mode in ("rgb_array", "human"):
        env = PlanetaryVisualWrapper(env, cfg)
    return env
