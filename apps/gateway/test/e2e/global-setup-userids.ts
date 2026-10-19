import type { TestProject } from "vitest/node";
import { startGateway } from "./global-setup";
import { ALLOWED_ID, ALLOWED_ID_2 } from "./userids-constants";

// user ID の許可リストだけの構成（ALLOWED_ORG / ALLOWED_TEAM は空）。LOGS（R2）は外す。
export default function setup(project: TestProject) {
  return startGateway(project, {
    logs: false,
    vars: {
      ALLOWED_ORG: "",
      ALLOWED_TEAM: "",
      ALLOWED_USER_IDS: `${ALLOWED_ID}, ${ALLOWED_ID_2}`,
    },
  });
}
