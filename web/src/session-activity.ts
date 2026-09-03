import { createContext, useContext } from "react";

export const SessionActivity = createContext(true);
export const useSessionActive = () => useContext(SessionActivity);
