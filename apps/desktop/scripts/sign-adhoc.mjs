import { signAsync } from "@electron/osx-sign";

// Force a certificate-free signature. electron-builder 26 treats identity "-"
// as a certificate-name substring before falling back to ad-hoc signing.
export default async function signAdHoc(options) {
  await signAsync({ ...options, identity: "-", identityValidation: false });
}
