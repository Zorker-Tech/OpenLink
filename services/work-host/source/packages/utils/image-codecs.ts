/**
 * The image codecs, loaded when an image is actually handled.
 *
 * Image work is a small part of what the platform does, and the codecs are heavy: the decoder set is
 * imported on first use and the instance is reused afterwards, so a process that never touches an
 * image never pays for the libraries.
 */

async function createImageCodecs() {
  const [
    { createJimp },
    { default: png },
    { default: jpeg },
    { default: bmp, msBmp },
    { default: gif },
    { default: tiff },
    { methods: resizeMethods },
  ] = await Promise.all([
    import("@jimp/core"),
    import("@jimp/js-png"),
    import("@jimp/js-jpeg"),
    import("@jimp/js-bmp"),
    import("@jimp/js-gif"),
    import("@jimp/js-tiff"),
    import("@jimp/plugin-resize"),
  ])
  return createJimp({ formats: [png, jpeg, bmp, msBmp, gif, tiff], plugins: [resizeMethods] })
}

export type ImageCodecs = Awaited<ReturnType<typeof createImageCodecs>>

let codecs: Promise<ImageCodecs> | undefined

export function getImageCodecs(): Promise<ImageCodecs> {
  if (codecs === undefined) {
    const initialization = createImageCodecs().catch((error: unknown) => {
      // A failed load must not be cached: the next caller should be able to try again.
      if (codecs === initialization) codecs = undefined
      throw error
    })
    codecs = initialization
  }
  return codecs
}
