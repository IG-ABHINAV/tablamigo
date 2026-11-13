// expo-secure-store in memory. `store` is exported so tests can see what the app saved on the phone.
export const store = new Map();
export const setItemAsync = async (k, v) => { store.set(k, v); };
export const getItemAsync = async k => (store.has(k) ? store.get(k) : null);
export const deleteItemAsync = async k => { store.delete(k); };
