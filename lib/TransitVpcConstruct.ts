import {Construct} from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import {IVpc, VpnConnectionType} from "aws-cdk-lib/aws-ec2";
import {RemovalPolicy} from "aws-cdk-lib";

export interface TransitVpcConstructProps {
    sshKeyPairName: string;
    sharedVpc: IVpc
}

/**
 * Construct usage is unused in main stack due to issues around getting
 * the AMI used in ec2 instance below.
 *
 * There is also some manual setup required for setting up VPN connections
 * which can't be covered through code.
 *
 * Included code for completeness sake but shouldn't be taken as the correct
 * way to setup such routing
 */
class TransitVpcConstruct extends Construct {
    constructor(scope: Construct, id: string, props: TransitVpcConstructProps) {
        super(scope, id);

        const transitVpc = new ec2.Vpc(this, "transit-vpc", {
            vpcName: "transit-vpc",
            cidr: "10.3.0.0/16",
            subnetConfiguration: []
        });
        transitVpc.applyRemovalPolicy(RemovalPolicy.DESTROY);

        const transitVpcSubnet = new ec2.Subnet(this, "transit-vpc-subnet", {
            vpcId: transitVpc.vpcId,
            availabilityZone: "eu-west-1a",
            cidrBlock: "10.3.0.0/24"
        });
        transitVpcSubnet.applyRemovalPolicy(RemovalPolicy.DESTROY);

        const transitVpcInternetGateway = new ec2.CfnInternetGateway(this, "transit-vpc-internet-gateway", {
            tags: [{ key: "Name", value: "transit-igw" }]
        });
        transitVpcInternetGateway.applyRemovalPolicy(RemovalPolicy.DESTROY);

        const transitVpcIgwAttachment = new ec2.CfnVPCGatewayAttachment(this, "transit-vpc-igw-attachment", {
            vpcId: transitVpc.vpcId,
            internetGatewayId: transitVpcInternetGateway.attrInternetGatewayId
        });
        transitVpcIgwAttachment.applyRemovalPolicy(RemovalPolicy.DESTROY);

        const transitVpcRouteTable = new ec2.CfnRouteTable(this, "transit-vpc-route-table", {
            vpcId: transitVpc.vpcId,
            tags: [{ key: "Name", value: "transit" }]
        });
        transitVpcRouteTable.applyRemovalPolicy(RemovalPolicy.DESTROY);

        const transitRouteTableDefaultRoute = new ec2.CfnRoute(this, "transit-route-table-default", {
            routeTableId: transitVpcRouteTable.attrRouteTableId,
            destinationCidrBlock: "0.0.0.0/0",
            gatewayId: transitVpcInternetGateway.attrInternetGatewayId
        });
        transitRouteTableDefaultRoute.applyRemovalPolicy(RemovalPolicy.DESTROY);

        const transitSubnetRouteTableAssociation = new ec2.CfnSubnetRouteTableAssociation(this, "transit-subnet-route-table-assc", {
            routeTableId: transitVpcRouteTable.attrRouteTableId,
            subnetId: transitVpcSubnet.subnetId
        });
        transitSubnetRouteTableAssociation.applyRemovalPolicy(RemovalPolicy.DESTROY);

        const transitInstanceSecGroup = new ec2.SecurityGroup(this, "transit-instance-sec-group", {
            vpc: transitVpc,
            securityGroupName: "Transit VPC ec2 instance security group"
        });
        transitInstanceSecGroup.applyRemovalPolicy(RemovalPolicy.DESTROY);
        transitInstanceSecGroup.addIngressRule(
            ec2.Peer.ipv4("24.96.0.0/16"),
            ec2.Port.tcp(22),
            "SSH access from ipv4 range 24.96.0.0/16"
        );

        const ciscoRouterInstance = new ec2.Instance(this, "cisco-router-instance", {
                vpc: transitVpc,
                keyName: props.sshKeyPairName,
                privateIpAddress: "10.3.0.10",
                vpcSubnets: {subnets: [transitVpcSubnet]},
                // AMI image does not support t2.micro type
                instanceType: new ec2.InstanceType("t2.medium"),
                instanceName: "transit-csr",
                machineImage: new ec2.LookupMachineImage({
                    // Not a good way of getting image reference but couldn't find way to
                    // make reference other way for this non-AWS owned AMI
                    name: "Cisco Cloud Services Router (CSR) 1000V - BYOL for Maximum Performance"
                })
            }
        );
        ciscoRouterInstance.applyRemovalPolicy(RemovalPolicy.DESTROY);

        const transitInstanceEip = new ec2.CfnEIP(this, "transit-instance-eip", {
            instanceId: ciscoRouterInstance.instanceId
        });
        transitInstanceEip.applyRemovalPolicy(RemovalPolicy.DESTROY);

        const transitVPG = new ec2.VpnGateway(this, "transit-vpc-gateway", {
            type: ec2.VpnConnectionType.IPSEC_1
        });
        transitVPG.applyRemovalPolicy(RemovalPolicy.DESTROY);

        const vpgVpcAttachment = new ec2.CfnVPCGatewayAttachment(this, "transit-vpc-vpg-attachment", {
            vpcId: props.sharedVpc.vpcId,
            vpnGatewayId: transitVPG.gatewayId
        });
        vpgVpcAttachment.applyRemovalPolicy(RemovalPolicy.DESTROY);

        /* TODO: Might need some means of attachment VPG to this. Cannot find how it is done through code
        * May get it for free from VPC attachment
         */
        const transitSharedVpcVpnConnection = new ec2.VpnConnection(this, "transit-shared-vpc-vpn-conn", {
            vpc: props.sharedVpc,
            // Using this public Ip should correspond to the Eip provisioned above.
            // Cannot get the value of this direct from Eip construct
            ip: ciscoRouterInstance.instancePublicIp
        });
        transitSharedVpcVpnConnection.applyRemovalPolicy(RemovalPolicy.DESTROY);

        /*
        * At this point when infra is created there needs to be manual steps
        *
        * 1: On AWS console open the VPN connection and download configuration file generated by AWS
        * 2: Open file and see line near top instructing to replace string with IP of router instance - 10.3.0.10 in this case
        * 3: Copy this config file and SSH into router instance
        * 4: Enter config mode with command 'conf t' then paste entire file
        * */

        const transitRoutePropagation = new ec2.CfnVPNGatewayRoutePropagation(this, "transitRouteProp", {
            vpnGatewayId: transitVPG.gatewayId,
            routeTableIds: ["*"]
        });
        transitRoutePropagation.applyRemovalPolicy(RemovalPolicy.DESTROY);

        // Code from here down is related to CloudHub module in Pluralsight course
        // Keeping in this undeployed class because it depends on transit VPC and
        // would run into issues with connection between an on-prem service which
        // doesn't actually exist
        //
        // Again used for completeness sake but would cause problems if deployed
        const onPremCustomerGateway1 = new ec2.CfnCustomerGateway(this, "on-prem-customer-gateway-1", {
            tags: [{ key: "Name", value: "chs-r1" }],
            bgpAsn: 65000,
            type: VpnConnectionType.IPSEC_1,
            ipAddress: "24.96.154.173"
        });
        onPremCustomerGateway1.applyRemovalPolicy(RemovalPolicy.DESTROY);

        const onPremCustomerGateway2 = new ec2.CfnCustomerGateway(this, "on-prem-customer-gateway-2", {
            tags: [{ key: "Name", value: "atl-r1" }],
            bgpAsn: 65001,
            type: VpnConnectionType.IPSEC_1,
            ipAddress: "24.96.154.174"
        });
        onPremCustomerGateway2.applyRemovalPolicy(RemovalPolicy.DESTROY);

        const cloudHubVPG = new ec2.VpnGateway(this, "on-prem-vpg", {
            type: VpnConnectionType.IPSEC_1
        });
        cloudHubVPG.applyRemovalPolicy(RemovalPolicy.DESTROY);

        const cloudHubVpGAttachment = new ec2.CfnVPCGatewayAttachment(this, "on-prem-vpc-transit-attachment", {
            vpcId: transitVpc.vpcId,
            vpnGatewayId: cloudHubVPG.gatewayId
        });
        cloudHubVpGAttachment.applyRemovalPolicy(RemovalPolicy.DESTROY);

        const onPrem1VPNConnection = new ec2.VpnConnection(this, "on-prem-1-vpn-connection", {
            vpc: transitVpc,
            ip: onPremCustomerGateway1.ipAddress
        });
        onPrem1VPNConnection.applyRemovalPolicy(RemovalPolicy.DESTROY);

        const onPrem2VPNConnection = new ec2.VpnConnection(this, "on-prem-2-vpn-connection", {
            vpc: transitVpc,
            ip: onPremCustomerGateway2.ipAddress
        });
        onPrem2VPNConnection.applyRemovalPolicy(RemovalPolicy.DESTROY);

        /*
        * Again here config files must be downloaded and applied through SSH connection
        * */
    }
}