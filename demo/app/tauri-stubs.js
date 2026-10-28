// Ни одна нативная команда из снимка не может обратиться к настоящему Tauri.
const blocked = async () => {
  throw new Error('Нативные действия в демо отключены.');
};
export const invoke = blocked;
export const listen = async () => () => {};
export const emit = blocked;
export const getVersion = async () => 'Демо';
export const open = blocked;
export const check = async () => null;
export const relaunch = blocked;
export const isPermissionGranted = async () => false;
export const requestPermission = async () => 'denied';
export const sendNotification = blocked;
export const convertFileSrc = () => '';
