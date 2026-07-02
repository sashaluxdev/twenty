import { defineApplication } from 'twenty-sdk/define';
import { DEFAULT_ROLE_UNIVERSAL_IDENTIFIER } from 'src/roles/default-role';

export const APPLICATION_UNIVERSAL_IDENTIFIER =
  '40f149e0-9a86-40bb-90dd-94f93e3e5ac2';

export default defineApplication({
  universalIdentifier: APPLICATION_UNIVERSAL_IDENTIFIER,
  displayName: 'Formula Field',
  description:
    'Chimeric formula fields: read the value, edit the formula. Arithmetic ' +
    'expressions over same-record, cross-record and cross-object fields.',
  defaultRoleUniversalIdentifier: DEFAULT_ROLE_UNIVERSAL_IDENTIFIER,
});
