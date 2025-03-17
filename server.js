import express from "express";
import { WebSocketServer as Server } from "ws";
import cors from "cors";
import { createServer } from "http";

const app = express();
app.use(cors());
app.use(express.json());

const server = createServer(app);
server.listen(3000, () => console.log("Servidor en puerto 3000"));

const wss = new Server({ server });

let salas = {}; // { "ABCD": { jugadores: [], juego: ws, mensajesPendientes: [] } }

function generarCodigo() {
    const letras = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let codigo;
    do {
        codigo = Array.from({ length: 4 }, () => letras[Math.floor(Math.random() * letras.length)]).join("");
    } while (salas[codigo]);
    return codigo;
}

app.post("/crear-sala", (req, res) => {
    let codigo = generarCodigo();
    salas[codigo] = { jugadores: [], juego: null, mensajesPendientes: [] };
    res.json({ codigo });
});

app.post("/seleccionar-avatar", (req, res) => {
    const { id, avatar } = req.body;
    if (!id || !avatar) return res.status(400).json({ error: "ID de jugador y avatar son requeridos" });
    for (let sala in salas) {
        let jugador = salas[sala].jugadores.find(j => j.id == id);
        if (jugador) {
            jugador.avatar = avatar;
            const mensaje = { tipo: "avatar-seleccionado", id, avatar };
            if (salas[sala].juego && salas[sala].juego.readyState === 1) {
                salas[sala].juego.send(JSON.stringify(mensaje));
            } else {
                salas[sala].mensajesPendientes.push(mensaje);
            }
            return res.json({ mensaje: "Avatar seleccionado con éxito" });
        }
    }
    res.status(404).json({ error: "Jugador no encontrado" });
});

wss.on("connection", (ws) => {
    console.log("✅ Nuevo WebSocket conectado.");
    let playerId = null;
    let salaActual = null;
    
    // Setup heartbeat
    const interval = setInterval(() => {
        if (ws.readyState === 1) {
            ws.send(JSON.stringify({ tipo: "ping" }));
        } else {
            clearInterval(interval);
        }
    }, 15000);

    ws.on("message", (msg) => {
        let data;
        try {
            data = JSON.parse(msg.toString());
        } catch (error) {
            console.log("❌ Error al parsear mensaje JSON:", error);
            return;
        }

        if (data.tipo === "unir") {
            let { sala, nombre } = data;
            salaActual = sala;
            
            if (!salas[sala]) {
                ws.send(JSON.stringify({ tipo: "error", mensaje: "Sala no encontrada" }));
                return;
            }

            // Verificar si el jugador ya existe por nombre
            let jugadorExistente = salas[sala].jugadores.find(j => j.nombre === nombre);
            if (jugadorExistente) {
                console.log(`⚠️ El jugador ${nombre} ya estaba en la sala, actualizando WebSocket.`);
                jugadorExistente.ws = ws;
                playerId = jugadorExistente.id;
                
                // Notificar al jugador que se ha reconectado
                ws.send(JSON.stringify({ 
                    tipo: "confirmacion-union", 
                    id: playerId,
                    reconectado: true,
                    avatar: jugadorExistente.avatar // Devolver el avatar actual si existe
                }));
                return;
            }

            // Buscar si el jugador existe en otras salas para preservar su avatar
            let avatarExistente = null;
            for (let otraSala in salas) {
                if (otraSala !== sala) {
                    let jugadorEnOtraSala = salas[otraSala].jugadores.find(j => j.nombre === nombre);
                    if (jugadorEnOtraSala && jugadorEnOtraSala.avatar) {
                        avatarExistente = jugadorEnOtraSala.avatar;
                        console.log(`ℹ️ Recuperado avatar ${avatarExistente} de jugador ${nombre} desde sala ${otraSala}`);
                        break;
                    }
                }
            }

            // Asignar nuevo ID de jugador
            playerId = salas[sala].jugadores.length;
            salas[sala].jugadores.push({ 
                id: playerId, 
                ws, 
                nombre, 
                avatar: avatarExistente, // Usar avatar recuperado o null
                activo: true
            });

            console.log(`✅ Jugador ${nombre} (${playerId}) unido a la sala ${sala}`);

            // Notificar a Unity sobre el nuevo jugador (si está conectado)
            if (salas[sala].juego && salas[sala].juego.readyState === 1) {
                try {
                    salas[sala].juego.send(JSON.stringify({ 
                        tipo: "nuevo-jugador", 
                        id: playerId, 
                        nombre 
                    }));
                    console.log("✅ Mensaje enviado a Unity.");
                    
                    // Si el jugador ya tenía un avatar, enviar esta información también
                    if (avatarExistente) {
                        salas[sala].juego.send(JSON.stringify({ 
                            tipo: "avatar-seleccionado", 
                            id: playerId, 
                            avatar: avatarExistente 
                        }));
                        console.log(`✅ Enviado avatar existente ${avatarExistente} para jugador ${nombre}`);
                    }
                } catch (error) {
                    console.log("❌ Error enviando mensaje a Unity:", error);
                    // Guardar los mensajes para enviarlos cuando Unity se reconecte
                    salas[sala].mensajesPendientes.push({ 
                        tipo: "nuevo-jugador", 
                        id: playerId, 
                        nombre 
                    });
                    
                    if (avatarExistente) {
                        salas[sala].mensajesPendientes.push({
                            tipo: "avatar-seleccionado",
                            id: playerId,
                            avatar: avatarExistente
                        });
                    }
                }
            } else {
                console.log("⚠️ WebSocket de Unity no está conectado. Guardando mensaje para envío posterior.");
                salas[sala].mensajesPendientes.push({ 
                    tipo: "nuevo-jugador", 
                    id: playerId, 
                    nombre 
                });
                
                if (avatarExistente) {
                    salas[sala].mensajesPendientes.push({
                        tipo: "avatar-seleccionado",
                        id: playerId,
                        avatar: avatarExistente
                    });
                }
            }

            // Confirmar unión al jugador e incluir el avatar si existe
            ws.send(JSON.stringify({ 
                tipo: "confirmacion-union", 
                id: playerId,
                avatar: avatarExistente // Incluir el avatar si existe
            }));
            
        } else if (data.tipo === "juego") {
            let { sala } = data;
            salaActual = sala;
            
            if (!salas[sala]) {
                ws.send(JSON.stringify({ tipo: "error", mensaje: "Sala no encontrada" }));
                return;
            }
            
            // Registrar la conexión de Unity
            salas[sala].juego = ws;
            console.log(`🎮 Unity conectado a la sala ${sala}`);
            
            // Enviar mensajes pendientes a Unity
            if (salas[sala].mensajesPendientes.length > 0) {
                console.log(`📤 Enviando ${salas[sala].mensajesPendientes.length} mensajes pendientes a Unity`);
                salas[sala].mensajesPendientes.forEach(mensaje => {
                    ws.send(JSON.stringify(mensaje));
                });
                salas[sala].mensajesPendientes = [];
            }
            
            // Enviar información de todos los jugadores conectados a Unity
            salas[sala].jugadores.forEach(jugador => {
                if (jugador.activo) {
                    ws.send(JSON.stringify({
                        tipo: "nuevo-jugador",
                        id: jugador.id,
                        nombre: jugador.nombre
                    }));
                    
                    // Si el jugador ya seleccionó un avatar, enviarlo también
                    if (jugador.avatar) {
                        ws.send(JSON.stringify({
                            tipo: "avatar-seleccionado",
                            id: jugador.id,
                            avatar: jugador.avatar
                        }));
                    }
                }
            });
        }
    });

    ws.on("close", () => {
        console.log("⚠️ Un WebSocket se ha desconectado.");
        clearInterval(interval);
        
        // Si es un jugador, marcarlo como inactivo pero no eliminarlo
        if (playerId !== null && salaActual && salas[salaActual]) {
            const jugador = salas[salaActual].jugadores.find(j => j.id === playerId);
            if (jugador) {
                console.log(`❌ Jugador ${playerId} desconectado de la sala ${salaActual}`);
                jugador.activo = false;
                
                // Notificar a Unity sobre la desconexión del jugador
                if (salas[salaActual].juego && salas[salaActual].juego.readyState === 1) {
                    salas[salaActual].juego.send(JSON.stringify({
                        tipo: "jugador-desconectado",
                        id: playerId
                    }));
                } else {
                    salas[salaActual].mensajesPendientes.push({
                        tipo: "jugador-desconectado",
                        id: playerId
                    });
                }
            }
        }
        
        // Si es Unity, marcar el juego como desconectado
        if (salaActual && salas[salaActual] && salas[salaActual].juego === ws) {
            console.log(`⚠️ Unity desconectado de la sala ${salaActual}`);
            salas[salaActual].juego = null;
        }
    });

    ws.on("error", (err) => {
        console.log(`⚠️ Error en WebSocket: ${err.message}`);
    });
});