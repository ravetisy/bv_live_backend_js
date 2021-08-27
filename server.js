const app = require("express")();
const http = require("http").Server(app);
const request = require("request");
const axios = require("axios");
const io = require("socket.io")(http);
const config = require("./config");
const firebase = require("firebase");
const cors = require("cors");
const eventUpdated = require("./event-updated");
const userTrack = require("./user-track");
const polls = require("./polls");
const chat = require("./chat");
const questions = require("./questions");
const port = process.env.PORT || 8000;

const redis = require('redis');
const subscriber = redis.createClient({host: config['REDIS_HOST'], port: config['REDIS_PORT']});
const publisher = subscriber.duplicate();

const fireBaseApp = firebase.initializeApp(config["firebaseConfig"]);
const ref = fireBaseApp.database().ref("node-client");
const messagesArr = ref.child("messages");
const adminMessagesArr = ref.child("adminMessages");
const usersArr = ref.child("users");
const questionsArr = ref.child("questions");
const pollsArr = ref.child("polls");
const commentsArr = ref.child("questionComments");
const meetingSettings = ref.child("meetingSettings");
const meetingConstants = ref.child("meetingConstants");
const activeSessionsRoomId = ref.child("activeSessionsRoomId");
const userMicCamera = ref.child("userMicCamera");

const bodyParser = require("body-parser");
let userEventToken = null;
let eventSocketConnectionsCount = 0;

let meetingRecordTokens = {};
let sessionsStreams = {};
let initialVirtualPagesPending = {
  currentEvent: false,
  customMenu: false,
  stageSessions: false,
  roomSessions: false,
  allSessions: false,
  sponsors: false,
  currentOrganization: false,
  sponsorRoom: false,
};
let virtualPagesPending = {...initialVirtualPagesPending};

let sock = null;

clearStreamURLCheck = (id) => {
  const int = sessionsStreams[id];
  if (int) {
    clearInterval(int);
    delete sessionsStreams[id];
  }
};

startStreamURLCheck = (id, streamURL) => {
  return new Promise((resolve, reject) => {
    sessionsStreams[id] = setInterval(() => {
      console.log("timeout");
      request(
        {
          url: streamURL,
          method: "GET",
        },
        function (error, response, body) {
          if (!error && body) {
            try {
              return JSON.parse(body);
            } catch (e) {
              if (typeof body === "string" && body.includes("#")) resolve(true);
            }
          }
        }
      );
    }, 8000);
  });
};

updateUserCloseDate = (id, data) => {
  let userId = data["externalUserId"];
  let partId = userId.split("#")[0];
  let closeDate = data["closeDate"];
  let userKey = partId + id;
  usersArr.child(userKey).once("value", (data) => {
    if (data.exists()) {
      let update = {};
      update[userKey] = {
        participantId: partId,
        externalUserId: userId,
        chatId: id,
        closeDate: closeDate,
      };
      usersArr.update(update);
    } else {
      usersArr.child(userKey).set({
        participantId: partId,
        externalUserId: userId,
        chatId: id,
        closeDate: closeDate,
      });
    }
  });
};

updateMeetingSettings = (id, meetingData) => {
  meetingSettings.child(id).once("value", (data) => {
    if (data.exists()) {
      let update = {};
      update[id] = meetingData;
      meetingSettings.update(update);
    } else {
      meetingSettings.child(id).set(meetingData);
    }
  });
};

getParticipant = (participantId) => {
  return new Promise((resolve, reject) => {
    publisher.hgetall('handshake', function(err, connectedUsers){
      if(!err && connectedUsers){
        for (let socketId in connectedUsers) {
          let user = JSON.parse(connectedUsers[socketId])
          const externalId = user["externalUserId"];
          if (externalId && externalId.split("#")[0] === participantId) {
            resolve(socketId);
          }
        }
        reject("User not found in socket! Part id => ", participantId);
      }
    });
  });
};

isHostPresent = () => {
  return new Promise((resolve) => {
    publisher.hgetall('handshake', function(err, connectedUsers){
      if(!err && connectedUsers){
        for (let socketId in connectedUsers) {
          const user = JSON.parse(connectedUsers[socketId]);
          const isHost = user["isHost"] || false;
          if (isHost) {
            resolve(true);
          }
        }
        resolve(false);
      }
    });
  });
};

startRecord = (url) => {
  return new Promise((resolve, reject) => {
    const meetingRecordAPIURL = config["recordAPIURL"];
    const recordURL = url.replace(/&/g, "%26");
    const recordApiURL = meetingRecordAPIURL + "?recordingAction=start&meetingURL=" + recordURL;
    axios({
      method: "POST",
      url: recordApiURL,
      responseType: "json",
    })
      .then(function (response) {
        resolve(response["data"]);
      })
      .catch(function (error) {
        console.log(error);
        reject(error.message);
      });
  });
};

stopRecord = (taskId) => {
  return new Promise((resolve, reject) => {
    const meetingRecordAPIURL = config["recordAPIURL"];
    const options = {
      url: `${meetingRecordAPIURL}?recordingAction=stop&taskId=${taskId}`,
      method: "POST",
      json: true,
    };
    request(options, function (error, response) {
      if (error) reject(error);
      resolve(response["body"]);
    });
  });
};

getRoster = (connectedUsers, chatId) => {
  return new Promise(async (resolve, reject) => {
    const roster = {};
    for (const userSocketObj of Object.values(connectedUsers)) {
      const userData = JSON.parse(userSocketObj);
      const id = userData.connectionId || '';

      if (
        userData != null &&
        userData["externalUserId"] &&
        userData["externalUserId"].includes("#") &&
        userData["chatId"] === chatId
      ) {
        const name = userData["name"] || "";
        const micEnabled = userData["micEnabled"] || false;
        const cameraEnabled = userData["cameraEnabled"] || false;
        const screenSharing = userData["screenSharing"] || false;
        const userImage = userData["userImage"] || "";
        const userPartId = userData["externalUserId"].split("#")[0];
        const isHost = userData["isHost"] || false;
        const is_speaker = userData["is_speaker"] || false;
        const email = userData["email"];
        const deviceId = userData["deviceId"] || "";
        const eventId = userData["eventId"] || "";

        const rosterData = {
          partId: userPartId,
          name: name,
          micEnabled,
          cameraEnabled,
          screenSharing,
          userImage: userImage,
          isHost,
          is_speaker,
          email: email,
          deviceId: deviceId,
        };

        await userMicCamera.child(eventId).child(userPartId).once("value", (data) => {
          if (data.exists()) {
            rosterData.micEnabled = data.val().micEnabled || false;
            rosterData.cameraEnabled = data.val().cameraEnabled || false;
          }
        })

        roster[id] = rosterData;
      } else {
        continue;
      }
    }
    resolve(roster);
  });
};

updateRoster = (data) => {
  for (const socketId in data) {
    const partRosterData = data[socketId];
    publisher.hget('handshake', socketId, function(error, value){
      if(!error && value){
          const userData = JSON.parse(value);
          userData["name"] = partRosterData["name"] || "";
          userData["micEnabled"] = partRosterData["micEnabled"] || false;
          userData["cameraEnabled"] = partRosterData["cameraEnabled"] || false;
          userData["screenSharing"] = partRosterData["screenSharing"] || false;
          userData["userImage"] = partRosterData["userImage"] || "";
          userData["is_speaker"] = partRosterData["is_speaker"] || false;
          userData["email"] = partRosterData["email"];
          userData["deviceId"] = partRosterData["deviceId"] || "";
          publisher.hset('handshake', socketId, JSON.stringify(userData));
      }
    });
  }
};

recordMeeting = (serverName, action, eventId, token) => {
  return new Promise((resolve, reject) => {
    console.log("// Meeting record request begin for =>", eventId, "Action =>", action);
    const recordingToken = config["recordingToken"].toString();
    const recordURLToken = recordingToken.slice(0, 6) + eventId + recordingToken.slice(6);
    const recordURL = `${serverName}/virtual-event?eventId=${eventId}&token=${token}&record=true&recordToken=${recordURLToken}`;
    switch (action) {
      case "start":
        console.log("Record URL => ", recordURL);
        startRecord(recordURL).then(
          (recordResponse) => {
            if (recordResponse && typeof recordResponse === "string") {
              meetingRecordTokens[eventId] = recordResponse;
              console.log("Meeting record tokens => ", meetingRecordTokens);
              resolve({
                isRecording: true,
                recordURL: recordURL,
              });
            } else
              reject({
                err: recordResponse["message"] || recordResponse["failures"] || "Invalid params",
                recordData: recordURL,
              });
          },
          (err) => {
            console.log("Record meeting start error =>", err);
            reject({
              err: err,
              recordData: recordURL,
            });
          }
        );
        break;
      case "stop":
        const meetingTaskId = meetingRecordTokens[eventId];
        console.log("Record task id for event", eventId, "=>", meetingTaskId);
        if (meetingTaskId) {
          stopRecord(meetingTaskId).then(
            (recordResponse) => {
              if (recordResponse && recordResponse["task"]) {
                delete meetingRecordTokens[eventId];
                resolve({
                  isRecording: false,
                  recordURL: recordURL,
                });
              } else
                reject({
                  err: "Meeting Record stop error",
                  recordData: "",
                });
              // const recordStopData = {
              //     eventCode: eventId,
              //     token: token,
              //     task: recordResponse['task']
              // }
              // sendStopRecordData(serverName, recordStopData);
            },
            (err) => {
              console.log("Record meeting start error =>", err);
              reject({
                err: err,
                recordData: "",
              });
            }
          );
        } else reject("Invalid parameters for record meeting");
        break;
      default:
        console.log("Invalid parameters for record meeting =>", serverName, action, eventId, token);
        reject("Invalid parameters for record meeting");
    }
  });
};

getNameByExtId = (externalUserId) => {
  return externalUserId.split("#")[1];
};

changeMeetingStatus = (chatId, status) => {
  meetingConstants.child(chatId).once("value", (data) => {
    if (data.exists()) {
      let statusUpdate = {};
      statusUpdate[chatId] = status;
      meetingConstants.update(statusUpdate);
    } else {
      meetingConstants.child(chatId).set(status);
    }
  });
};

const checkSessionsIsReset = async (eventId, token) => {
  if (!eventId || !token) {
    return;
  }
  const activeRoomSessions = [];

  axios
    .get(`${config.BACKEND_URL}/events/custom-menu/${eventId}`, {
      headers: {token},
    })
    .then(async ({data}) => {
      const customMenu = data.data;

      await Promise.all(
        customMenu.map(async (menu, index) => {
          const virtualRoomId = menu.room_id;
          const isSessionRoom = index === 1 || (index > 3 && menu.type === "room");
          if (isSessionRoom) {
            return axios
              .get(`${config.BACKEND_URL}/room-session/${eventId}/${virtualRoomId}`, {
                headers: {token},
              })
              .then(({data}) => {
                if (data.data.some((session) => session.status === "active")) {
                  activeRoomSessions.push(+virtualRoomId);
                }
              });
          }
        })
      );

      io.sockets.in(eventId).emit("active_sessions_rooms", activeRoomSessions);
      activeSessionsRoomId.child(eventId).set(activeRoomSessions);
    })
    .catch((e) => {
      console.log(e);
    });
};

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended: true}));

app.get("/", function (req, res) {
  res.send("Server Working!");
});

app.get("/change-meeting", function (req, res) {
  console.log("Change Meeting Settings => ", req.query);
  if (req.query && req.query["chat"]) {
    req.query["chat"].map((socketId) => {
      io.sockets.in(socketId) &&
      io.sockets.in(socketId).emit("change_app_info", {
        date: new Date().getTime(),
      });
    });
  }
});

app.get("/join-meeting-handler", function (req, res) {
  console.log("Joining all users to meeting => ", req.query);
  const chatId = req.query["meetingCode"];
  const companyToken = req.query["token"];
  if (chatId && companyToken) {
    io.sockets.in(chatId) &&
    io.sockets.in(chatId).emit("join_meeting", {
      date: new Date().getTime(),
    });
  }
});

app.get("/event-updated", function (req, res) {
  console.log("Change Event Settings => ", req.query);
  virtualPagesPending = {...initialVirtualPagesPending};
  const {eventCode = ""} = req.query || {};

  if (eventCode && io.sockets.in(eventCode)) {
    io.sockets.in(eventCode).emit("event_updated", {
      date: new Date().getTime(),
    });
  }

  userEventToken && checkSessionsIsReset(eventCode, userEventToken);

  res.send("success");
});

const getMessages = ({count, chat_id, partId, isAdmin, sessionId}) => {
  return new Promise(async (resolve, reject) => {
    try {
      const increasingQuantity = count === 0 ? 20 : 5;
      const userKey = partId + chat_id;
      const userData = await usersArr.child(userKey).once("value");
      const closeDate = userData.exists() ? userData.val()["closeDate"] : null;
      let messages = {};
      let newData = {};

      if (isAdmin) {
        messages = await adminMessagesArr.orderByChild("chatId").equalTo(chat_id).once("value");
        const data = messages.val();
        newData = Object.entries(data).filter(item => item[1]["sessionId"] == sessionId).reverse();
      } else {
        messages = await messagesArr.orderByChild("chatId").equalTo(chat_id).once("value");
        const data = messages.val();
        newData = Object.entries(data)
          .reverse()
          .filter(([key, currentMessage]) => {
            return (
              currentMessage["receiverParticipantId"] === partId ||
              currentMessage["senderParticipantId"] === partId ||
              currentMessage["receiverParticipantId"] === "all"
            );
          });
      }

      const messagesRange = count + increasingQuantity;
      const filteredMessages = newData
        .slice(count, messagesRange)
        .map(([key, currentMessage]) => {
          const senderName = getNameByExtId(currentMessage["senderUserId"]);
          const receiverName =
            currentMessage["receiverUserId"] && currentMessage["receiverUserId"] !== "Everyone"
              ? getNameByExtId(currentMessage["receiverUserId"])
              : "Everyone";
          return {
            messageId: key,
            date: currentMessage["date"],
            isFile: currentMessage["isFile"],
            sender: senderName,
            senderImage: currentMessage["senderImage"] || "",
            senderPartId: currentMessage["senderParticipantId"],
            receiver: receiverName,
            receiverPartId: currentMessage["receiverParticipantId"],
            data: currentMessage["data"],
            fileName: currentMessage["fileName"],
            sendNotification: closeDate
              ? new Date(closeDate) <= new Date(currentMessage["date"])
              : currentMessage["sendNotification"],
            isMessagePinned: currentMessage["isPinned"],
            mentions: currentMessage["mentions"] || [],
          };
        })
        .reverse();

      const hasMore = newData.length > count + increasingQuantity;

      resolve({data: filteredMessages, hasMore});
    } catch (error) {
      reject(error);
    }
  });
};

app.post("/get-messages", async function (req, res) {
  const {count, chat_id, partId} = req.body;
  getMessages({count, chat_id, partId, isAdmin: false})
    .then(({data, hasMore}) => {
      res.send({data, hasMore});
    })
    .catch((error) => {
      res.status(400).send(error);
    });
});

app.post("/get-admin-messages", async function (req, res) {
  const {count, chat_id, partId, sessionId} = req.body;

  getMessages({count, chat_id, partId, isAdmin: true, sessionId})
    .then(({data, hasMore}) => {
      res.send({data, hasMore});
    })
    .catch((error) => {
      res.status(400).send(error);
    });
});

subscriber.on("pmessage", function(pattern, channel, message) {
  if(pattern == `push handshake*` && sock){
    const chatId = channel.split('#')[1];
    sock.to(chatId).emit("update_roster", message);
  }
});

subscriber.psubscribe(`push handshake*`);

io.on("connection", async function (socket) {
  sock = socket;
  // Define chat id and wait session id, if users is waiting for host
  const chatId = socket["handshake"]["query"]["chatId"] || null;
  const waitSessionId = socket["handshake"]["query"]["waitSessionId"] || null;
  // Check for host waiting and for chat id existing

  if (waitSessionId) {
    return socket.join(waitSessionId);
  } else if (!chatId) {
    return false;
  }

  // Define variables for user if chat id exists

  const socketQuery = socket["handshake"]["query"];
  // const meetingId = socketQuery['meetingId'] || null;
  // const meetingStepId = socketQuery['meetingStepId'] || null;
  const eventId = socketQuery["eventId"] || null;
  // const token = socketQuery['token'] || null;
  const externalUserId = socketQuery["externalUserId"] || null;
  const serverName = socketQuery["serverName"] || null;
  const roomId = socketQuery["roomId"] || null;
  const partId = externalUserId ? externalUserId.split("#")[0] : null;
  const isRecorder = socketQuery["isRecorder"] || null;
  const isHost = socketQuery["isHost"] || null;
  const {conn: {id: socketConnectionId = ""} = {}} = socket ? socket!= null : {};
  const token = socketQuery["token"];
  const refreshToken = socketQuery["refreshToken"];
  const eventSocket = socketQuery["eventSocket"];
  const browser = socketQuery["browser"];
  const OS = socketQuery["OS"];
  const location = socketQuery["location"];
  const device = socketQuery["device"];
  const ip = socket.handshake.address;
  const userKey = partId + chatId;
  const userData = await usersArr.child(userKey).once("value");
  const closeDate = userData.exists() ? userData.val()["closeDate"] : null;
  const activeSession = {
    customMenuId: null,
    sessionId: null,
  }; // for left the session track
  userEventToken = token;
  
  // Join to socket
  if (eventSocket) {
    if (!eventSocketConnectionsCount) {
      checkSessionsIsReset(eventId, token);
    }

    eventSocketConnectionsCount += 1;

    activeSessionsRoomId.child(eventId).once("value", (data) => {
      if (data.exists()) {
        io.sockets.connected[socket.id].emit("active_sessions_rooms", data.val());
      }
    });

    userMicCamera
      .child(eventId)
      .child(partId)
      .once("value", (data) => {
        if (data.exists()) {
          io.sockets.connected[socket.id].emit("user_mic_video", data.val());
        }
      });
  }

  socket.join(chatId);

  // Check for host existing in meeting

  isHostPresent().then((present) => {
    if (io.sockets.connected[socket.id])
      io.sockets.connected[socket.id] &&
      io.sockets.connected[socket.id].emit("host_present", present);
  });

  // Send data (messages, questions, comments and settings) for connected user
  if (!eventSocket) {
    if(socketConnectionId){
      socketQuery['connectionId'] = socketConnectionId;
      const queryString = JSON.stringify( {...socketQuery, partId, connectionId: socketConnectionId});
      publisher.hset('handshake', socketConnectionId, queryString);
      publisher.publish(`push handshake#${chatId}`, queryString);
    }
    publisher.hgetall('handshake', function(err, value){
      if(!err && value){
        getRoster(value, chatId).then(
          (roster) => {
            setTimeout(() => {
              // getting; whole participants list for new connection
              io.sockets.connected[socket.id] && io.sockets.connected[socket.id].emit("get_participants", roster)
            }, 500);
          },
          (err) => {
            console.log("Error on get roster => ", err);
          }
        );
      }
    });    

  }

  meetingSettings.child(chatId).once("value", (data) => {
    const settings = data.val();
    io.sockets.connected[socket.id] &&
    io.sockets.connected[socket.id].emit("change_meeting_settings", {
      meetingSettings: settings || [],
      isEntry: true,
    });
  });

  meetingConstants.child(chatId).once("value", (data) => {
    const statusObject = data.val() || {};
    io.sockets.connected[socket.id] &&
    io.sockets.connected[socket.id].emit("change_meeting_status", statusObject);
  });

  // Define functions for socket

  // Roster

  socket.on("update_roster", (id, data) => {
    if (data[socketConnectionId]) {
      const {micEnabled = false, cameraEnabled = false} = data[socketConnectionId] || {};
      updateRoster(data);
      userMicCamera.child(eventId).child(partId).set({micEnabled, cameraEnabled});
      io.sockets.in(id) && io.sockets.in(id).emit("update_roster", data);
    }
  });

  socket.on("left_chat", (id, data) => {
    updateUserCloseDate(id, data);
  });

  //Chat Functionality
  chat({
    io,
    socket,
    messagesArr,
    adminMessagesArr,
    publisher
  });

  // Q&A Functionality
  questions({
    io,
    socket,
    questionsArr,
    commentsArr,
    chatId,
    closeDate,
  });

  // Polls Functionality
  polls({
    io,
    socket,
    pollsArr,
    chatId,
    isHost,
    partId,
  });

  // Host features functionality
  socket.on("mute_all", (id, data) => {
    if (isHost) {
      io.sockets.in(id) &&
      io.sockets.in(id).emit("mute_microphone", {
        date: new Date(),
      });
    }
  });

  socket.on("unmute_all", (id, data) => {
    if (isHost) {
      io.sockets.in(id) &&
      io.sockets.in(id).emit("unmute_microphone", {
        date: new Date(),
      });
    }
  });

  socket.on("disable_video_all", (id, data) => {
    if (isHost) {
      io.sockets.in(id) &&
      io.sockets.in(id).emit("disable_video", {
        date: new Date(),
      });
    }
  });

  socket.on("change_host", (id, data) => {
    if (isHost) {
      const hostParticipantId = data["newHostPartId"];
      getParticipant(hostParticipantId).then((socketId) => {
        io.sockets.connected[socketId] &&
        io.sockets.connected[socketId].emit("change_host", hostParticipantId);
      });
    }
  });

  socket.on("change_meeting_settings", (id, data) => {
    if (isHost) {
      updateMeetingSettings(id, data);
      io.sockets.in(id) &&
      io.sockets.in(id).emit("change_meeting_settings", {
        meetingSettings: data,
        isEntry: false,
      });
    }
  });

  socket.on("change_meeting_status", (id, data) => {
    if (isHost) {
      changeMeetingStatus(id, data);
      io.sockets.in(id) && io.sockets.in(id).emit("change_meeting_status", data);
      if (data && data["status"] && data["status"] === "finished") {
        io.sockets.in(id) &&
        io.sockets.in(id).emit("end_meeting", {
          date: new Date(),
        });
      }
    }
  });

  socket.on("update_meeting_session", (id, data) => {
    if (isHost) {
      io.sockets.in(id) && io.sockets.in(id).emit("update_meeting_session", data);
      clearStreamURLCheck(id);
    }
  });

  socket.on("check_streaming_url", (id, data) => {
    const {streamURL, roomId} = data;
    if (isHost && streamURL) {
      startStreamURLCheck(id, streamURL).then(() => {
        io.sockets.in(id) &&
        io.sockets.in(id).emit("update_meeting_session", {
          event_code: eventId,
          roomId: roomId,
        });
        clearStreamURLCheck(id);
      });
    }
  });

  socket.on("end_meeting_for_all", (id, data) => {
    if (isHost) {
      io.sockets.in(id) &&
      io.sockets.in(id).emit("end_meeting", {
        date: new Date(),
      });
    }
  });

  socket.on("mute_participant", (id, data) => {
    if (isHost) {
      const partId = data["partId"];
      getParticipant(partId).then((socketId) => {
        io.sockets.connected[socketId] &&
        io.sockets.connected[socketId].emit("mute_microphone", {
          date: new Date(),
        });
      });
    }
  });

  socket.on("unmute_participant", (id, data) => {
    if (isHost) {
      const partId = data["partId"];
      getParticipant(partId).then((socketId) => {
        io.sockets.connected[socketId] &&
        io.sockets.connected[socketId].emit("unmute_microphone", {
          date: new Date(),
        });
      });
    }
  });

  socket.on("disable_participant_video", (id, data) => {
    if (isHost) {
      const partId = data["partId"];
      getParticipant(partId).then((socketId) => {
        io.sockets.connected[socketId] &&
        io.sockets.connected[socketId].emit("disable_video", {
          date: new Date(),
        });
      });
    }
  });

  socket.on("pause_streaming", (id, data) => {
    if (isHost) {
      const isPaused = data["streamingPaused"];
      updateMeetingSettings(id, data);
      io.sockets.in(id) && io.sockets.in(id).emit("pause_streaming", isPaused);
    }
  });

  // Meeting recording functionality

  socket.on("check_record_token", (data) => {
    const token = data["recordToken"];
    const eventId = data["eventId"];
    const recordingToken = config["recordingToken"];
    const isTokenValid = isRecorder && recordingToken === token.replace(eventId, "");
    io.sockets.connected[socket.id] &&
    io.sockets.connected[socket.id].emit("check_record_token", isTokenValid);
  });

  socket.on("record_meeting", (id, data) => {
    const action = data["recordAction"];
    const eventId = data["eventId"];
    const companyToken = data["token"];
    recordMeeting(serverName, action, eventId, companyToken).then(
      (action) => {
        io.sockets.in(id) && io.sockets.in(id).emit("record_change", action["isRecording"]);
        io.sockets.in(id) &&
        io.sockets
          .in(id)
          .emit(
            "record_log",
            `Meeting recording request, isRecording => ${action["isRecording"]}, URL => ${action["recordURL"]}`
          );
        console.log("// Meeting record request end for", eventId, "\n");
      },
      (err) => {
        const recordLog = "Recording error, URL => " + err["recordData"] + " Data => " + err["err"];
        io.sockets.in(id) && io.sockets.in(id).emit("record_log", recordLog);
        console.log("Meeting record fail, URL => ", err);
        console.log("// Meeting record request end for", eventId, "\n");
      }
    );
  });

  socket.on("realtime_update", (chat_id, data) => {
    eventUpdated({
      virtualPagesPending,
      initialVirtualPagesPending,
      io,
      chat_id,
      eventId,
      token,
      refreshToken,
      mainData: data,
    });
  });

  socket.on("track_session", (id, data) => {
    const {customMenuId, sessionId} = data;
    activeSession.customMenuId = customMenuId;
    activeSession.sessionId = sessionId;
  });

  socket.on("active_sessions_rooms", (eventId, data) => {
    socket.activeSessions = data;
    io.sockets.in(eventId).emit("active_sessions_rooms", [...data]);
    activeSessionsRoomId.child(eventId).set([...data]);
  });

  // Socket disconnect
  socket.on("disconnect", () => {
    let userData = {
      externalUserId: externalUserId,
      closeDate: new Date().getTime(),
    };
    updateUserCloseDate(chatId, userData);

    const rosterSendData = {
      socketConnectionId,
      disconnect: true,
    };
    publisher.hdel('handshake', socketConnectionId); 
    // subscriber.unsubscribe(`push handshake#${chatId}`)
    io.sockets.in(chatId) && io.sockets.in(chatId).emit("roster_disconnect", rosterSendData);

    if (eventSocket) {
      if (eventSocketConnectionsCount === 1) {
        io.sockets.in(eventId).emit("active_sessions_rooms", []);
        activeSessionsRoomId.child(eventId).set([]);
      }
      eventSocketConnectionsCount -= 1;

      if (activeSession.customMenuId && activeSession.sessionId) {
        userTrack.userLeaveSession({
          eventId,
          token,
          refreshToken,
          browser,
          OS,
          location,
          device,
          ip,
          customMenuId: activeSession.customMenuId,
          sessionId: activeSession.sessionId,
        });
      }

      userTrack.userLeave({
        eventId,
        token,
        refreshToken,
        browser,
        OS,
        location,
        device,
        ip,
      });
    }
  });
});

closeMeeting = (url, meetingData) => {
  console.log("Close Meeting Request =>", url, "Request Data => ", meetingData);
  if (url) {
    const options = {
      url: `${url}finish-call`,
      method: "POST",
      body: meetingData,
      json: true,
    };
    request(options, function (error, response) {
      if (error) return console.log(error);
      console.log("Close meeting response => ", response["body"]);
      // recordMeeting(url, 'stop', meetingData['event_id'], meetingData['token']).then(
      //     action => {
      //         console.log('// Meeting record request end for', meetingData['event_id'], '\n');
      //     },
      //     err => {
      //         const recordLog = 'Recording error, URL => ' + err['recordData'] + ' Data => ' + err['err'];
      //         console.log(recordLog);
      //         console.log('// Meeting record request end for', meetingData['event_id'], '\n');
      //     });
    });
  }
};

http.listen(port, function () {
  console.log("listening on *:" + port);
});
