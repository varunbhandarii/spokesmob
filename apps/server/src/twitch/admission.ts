export interface RequestAdmission {
  signal: AbortSignal;
  allowed(): boolean;
}
export class AdmissionCancelled extends Error {
  constructor() {
    super("Request admission cancelled");
    this.name = "AdmissionCancelled";
  }
}
export function checkAdmission(admission?: RequestAdmission) {
  if (admission && (admission.signal.aborted || !admission.allowed()))
    throw new AdmissionCancelled();
}
