# Box factory policy

The production box factory starts with a loopback box. It wraps that box in the shared-desktop facade only when its
capability reports support for more than one window; unsupported boxes retain object identity and their original
behavior. The startup summary reports the loopback backend, container image, update switch, and packaged/development
state.
