# Astreusn — Ubuntu Desktop wallpapers

The Astreusn TRANSIT wordmark on the Hydite paper surface.

| File | Use |
| --- | --- |
| `astreusn-ubuntu-light-3840x2160.png` | Light appearance (ink wordmark) |
| `astreusn-ubuntu-dark-3840x2160.png` | Dark appearance (paper-white wordmark) |
| `astreusn-ubuntu-{light,dark}-2560x1440.png` | QHD |
| `astreusn-ubuntu-{light,dark}-1920x1080.png` | FHD |
| `astreusn.xml` | GNOME entry pairing light + dark into one wallpaper |

## Install

Personal, no root:

```sh
mkdir -p ~/.local/share/backgrounds
cp astreusn-ubuntu-*.png ~/.local/share/backgrounds/
```

Then pick the file in Settings → Appearance → Background. GNOME does not follow
the light/dark pair for files added this way, so choose the variant you want (or
switch it together with the system appearance).

System-wide, with the pair wired to the system appearance:

```sh
sudo mkdir -p /usr/share/backgrounds/astreusn
sudo cp astreusn-ubuntu-*.png /usr/share/backgrounds/astreusn/
sudo cp astreusn.xml /usr/share/gnome-background-properties/
```

The XML paths are absolute and expect the `-3840x2160` files in that directory.

## How the background was built

The ground is Hydite's homepage surface, not a lookalike:

- paper base `oklch(.965 .012 82)`
- the site's four radial blooms, at its positions and hues — `62% 18%` warm amber,
  `12% 58%` gold, `88% 83%` coral, `16% 106%` sage
- the paper end of its `145deg` wash; the saturated stops live further down a
  325dvh page, so a single 16:9 frame only carries the top of it
- its paper grain (`home-hero/grain@2x.png`), tiled at 300px and blended the same
  way the site blends it

The dark variant is the same construction re-pitched for ink — the same fibre and
the same four bloom positions on a soft charcoal (`#211e1a`) ground, since Hydite
has no dark surface of its own. Its grain is screened rather than multiplied: the
texture is mid-grey with the noise entirely in the alpha channel, so it darkens a
light ground but disappears on a dark one.

Wordmarks are the vectors from `public/logos/01 — TRANSIT/Primary/`, unmodified,
at their own colours (`#101318` and `#F3F5F7`), spanning 26% of the canvas width
and centred.
