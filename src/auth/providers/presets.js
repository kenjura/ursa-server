/**
 * OIDC presets: vendor name → how to build an issuer URL from config.
 * The bundled scheme (docs/AUTH.md) is the auth0 preset.
 */
export const presets = {
  auth0: ({ domain }) => ({ issuer: `https://${domain}/` }),
  clerk: ({ domain }) => ({ issuer: `https://${domain}` }),
  cognito: ({ region, userPoolId }) => ({ issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}` }),
  google: () => ({ issuer: "https://accounts.google.com" }),
};
