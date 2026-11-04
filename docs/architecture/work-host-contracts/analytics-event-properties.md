# Analytics event property contract

Slate analytics events carry only string, number, boolean, or bigint properties. Normalization copies every value of
those primitive types, including empty strings, zero, and false, and omits missing, null, object, and list values. A
missing property map produces a fresh empty result. The analytics interop adapter is responsible for encoding these
owned primitives into the external event message.
