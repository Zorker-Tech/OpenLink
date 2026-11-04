# Box desktop endpoint contract

The box endpoint owns the image tag, primary and fork noVNC ports, and the special-treatment viewer path. A desktop URL
includes the network token, optional viewer token, and bounded websockify resume window. Token values are encoded as
query data in both the outer viewer URL and its nested websockify path, so reserved URL characters remain part of the
credential rather than changing the query structure.

Special-treatment detection is based on the URL path; malformed URLs and ordinary viewer paths are not classified as
special treatment.
