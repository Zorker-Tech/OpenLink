# Image codec loader contract

Image codecs are loaded only when image work first requests them. Concurrent callers share the same initialization
promise and the resolved codec instance is reused. The codec set includes the supported raster decoders and resize
plugin. If initialization rejects, that failed promise is cleared so a later call can retry.
